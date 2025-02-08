import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import fs from 'fs';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get command line arguments
const publicFolderPath = process.argv[2] || path.join(__dirname, '../public');
const apiConfigPath = process.argv[3] || path.join(__dirname, '../apis/fire-and-ice.yml');

// Read and validate API configuration
let api;
try {
    const apiConfig = fs.readFileSync(apiConfigPath, 'utf8');
    api = yaml.load(apiConfig);
    if (!api.baseUrl || !api.documentation) {
        throw new Error('Invalid API configuration: missing baseUrl or documentation');
    }
} catch (error) {
    console.error(`Error: Could not load API configuration from '${apiConfigPath}':`, error.message);
    process.exit(1);
}

// Validate if the public folder exists
if (!fs.existsSync(publicFolderPath)) {
  console.error(`Error: Public folder '${publicFolderPath}' does not exist`);
  process.exit(1);
}

const app = express();

const openai = new OpenAI();

// Add CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Serve static files from the specified public directory
app.use(express.static(publicFolderPath));

// Use body-parser middleware for text
app.use(bodyParser.text({ type: '*/*' }));

function logError(context, error, details = {}) {
  console.error(`[ERROR] ${context}:`, {
    message: error.message,
    stack: error.stack,
    ...details
  });
}

function logRequest(method, path, body) {
  console.log(`[REQUEST] ${method} ${path}`, body ? {
    body: body.length > 1000 ? body.substring(0, 1000) + '...' : body
  } : '');
}

function logResponse(status, body) {
  console.log(`[RESPONSE] Status: ${status}`, {
    body: typeof body === 'string' && body.length > 1000 ? 
      body.substring(0, 1000) + '...' : body
  });
}

const MAX_CALLS_PER_PROMPT = 5;

const GENERIC_API_TOOLS = [{
  "type": "function",
  "function": {
      "name": "http_get",
      "description": "Perform an HTTP GET request. Can be used in sequence with other calls when needed. The response may contain data needed for subsequent calls.",
      "parameters": {
          "type": "object",
          "properties": {
              "path": {
                  "type": "string",
                  "description": "the path to be appended to the base url"
              }
          },
          "required": ["path"],
          "additionalProperties": false
      },
      "strict": true
  }
}, {
  "type": "function",
  "function": {
      "name": "http_post",
      "description": "Perform an HTTP POST request to the specified path with the specified body and return the response body as a string.",
      "parameters": {
          "type": "object",
          "properties": {
              "path": {
                  "type": "string",
                  "description": "the path to be appended to the base url"
              },
              "body": {
                  "type": "string",
                  "description": "the body to be sent with the POST request"
              }
          },
          "required": ["path", "body"],
          "additionalProperties": false
      },
      "strict": true
  }
}];

async function transformPromptToApiCall(sessionId, prompt) {  
  try {
    const systemPrompt = `You are an assistant that helps people with calling REST APIs of a specific service.
      You have three options:
      1. If the request can be answered directly without API calls, provide a direct response.
      2. If the request needs a single API call, specify that call.
      3. If the request needs multiple sequential API calls (up to ${MAX_CALLS_PER_PROMPT}), plan them in sequence.
         For example, if you need to get a list of IDs first and then get details for each ID.
      
      The API base URL is: ${api.baseUrl}
      Here is the API documentation:
      ${api.documentation}
    `;

    const response = await openai.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt }, 
        { role: "user", content: prompt }
      ],
      model: "gpt-4o-mini",
      tools: GENERIC_API_TOOLS,
    });

    const message = response.choices[0].message;
    
    // Direct response case
    if (!message.tool_calls) {
      return { direct_response: true, content: message.content };
    }

    // API calls case
    return message;
  } catch (error) {
    logError('Transform prompt to API call', error, { prompt });
    return null;
  }
}

async function processApiCalls(message, initialPrompt) {
  try {
    let allResponses = [];
    let currentMessage = message;
    
    for (let i = 0; i < MAX_CALLS_PER_PROMPT; i++) {
      if (!currentMessage.tool_calls) break;
      
      // Perform the current API call
      const apiResponse = await perform(currentMessage);
      if (!apiResponse) throw new Error(`API call ${i + 1} failed`);
      allResponses.push(apiResponse);

      // Check if more calls are needed
      if (i < MAX_CALLS_PER_PROMPT - 1) {
        const nextResponse = await openai.chat.completions.create({
          messages: [
            { role: "system", content: "Based on the previous API response, determine if and what additional API calls are needed." },
            { role: "user", content: initialPrompt },
            { role: "assistant", content: JSON.stringify(currentMessage) },
            { role: "user", content: `Previous API response: ${JSON.stringify(apiResponse)}. Are additional API calls needed?` }
          ],
          model: "gpt-4o-mini",
          tools: GENERIC_API_TOOLS,
        });
        
        currentMessage = nextResponse.choices[0].message;
        if (!currentMessage.tool_calls) break;
      }
    }
    
    return allResponses;
  } catch (error) {
    logError('Process API calls', error);
    return null;
  }
}

app.post('/', async (req, res) => {
  try {
    logRequest('POST', '/', req.body);
    const prompt = req.body;
    
    const transformResult = await transformPromptToApiCall(1, prompt);
    if (!transformResult) {
      throw new Error('Failed to transform prompt');
    }

    // Handle direct response
    if (transformResult.direct_response) {
      logResponse(200, transformResult.content);
      return res.send(transformResult.content);
    }

    // Handle API calls
    const apiResponses = await processApiCalls(transformResult, prompt);
    if (!apiResponses) {
      throw new Error('API calls failed');
    }

    const response = await transformApiResponseToResponse(1, prompt, transformResult, apiResponses);
    if (!response) {
      throw new Error('Failed to transform API response');
    }

    logResponse(200, response);
    res.send(response);
  } catch (error) {
    logError('Request handler', error, { prompt: req.body });
    res.status(500).send(`Error processing request: ${error.message}`);
  }
});

async function perform(apiCall) {
  try {
    const f = apiCall.tool_calls[0].function;
    const method = f.name;
    const args = JSON.parse(f.arguments);
    const path = args.path;
    const url = `${api.baseUrl}${path}`;

    if (method === 'http_get') {
      console.log('Performing GET request to:', url);
      const response = await fetch(url);
      const responseBody = await response.text();
      console.log(responseBody);
      return responseBody;
    } else if (method === 'http_post') {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: args.body ? JSON.stringify(args.body) : undefined
      });
      return await response.json();
    } else {
      console.error('Unsupported function:', method);
      return '';
    }
  } catch (error) {
    logError('Perform API call', error, { apiCall });
    return null;
  }
}

async function transformApiResponseToResponse(sessionId, prompt, apiCall, apiResponses) {
  try {
    const systemPrompt = `You are an assistant that helps people with calling REST APIs of a specific service.
      You help translating from HTTP responses to human-readable responses. You generate plain text responses 
      that are easy to understand. No JSON, XML or MarkDown, just plain text.
      If multiple API calls were made, combine their results into a coherent response.
    `;

    const requestText = `I asked the following question: 
    ${prompt}
    The API calls and responses were:
    ${JSON.stringify({ calls: apiCall, responses: apiResponses })}
    Please help me translate these responses to a human-readable response.
    `;

    const response = await openai.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt }, 
        { role: "user", content: [{ type: "text", text: requestText }] }
      ],
      model: "gpt-4o-mini"
    });

    return response.choices[0].message.content;
  } catch (error) {
    logError('Transform API response', error, { prompt, apiCall, apiResponses });
    return null;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API Configuration loaded from: ${apiConfigPath}`);
  console.log(`Serving UI from: ${publicFolderPath}`);
  console.log(`Send POST requests to http://localhost:${PORT} or open the UI in your browser`);
  console.log(`Server running.`);
  console.log(`Press CTRL+C to stop the server`);
});
