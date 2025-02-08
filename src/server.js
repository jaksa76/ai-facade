import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get command line arguments
const publicFolderPath = process.argv[2] || path.join(__dirname, '../public');
const apiConfigPath = process.argv[3] || path.join(__dirname, '../apis/fire-and-ice.json');

// Read and validate API configuration
let api;
try {
    const apiConfig = fs.readFileSync(apiConfigPath, 'utf8');
    api = JSON.parse(apiConfig);
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

app.post('/', async (req, res) => {
  const prompt = req.body;
  const apiCall = await transformPromptToApiCall(1, prompt);
  const apiResponse = await perform(apiCall);
  const response = await transformApiResponseToResponse(1, prompt, apiCall, apiResponse);
  res.send(response);
});

const GENERIC_API_TOOLS = [{
  "type": "function",
  "function": {
      "name": "http_get",
      "description": "Perform an HTTP GET request to the specified path with the specified url parameters and return the response body as a string.",
      "parameters": {
          "type": "object",
          "properties": {
              "path": {
                  "type": "string",
                  "description": "the path to be appended to the base url"
              }
          },
          "required": [
              "path"
          ],
          "additionalProperties": false
      },
      "strict": true
  }
}];

async function transformPromptToApiCall(sessionId, prompt) {  
  try {
    const systemPrompt = `You are an assistant that helps people with calling REST APIs of a specific service.
      Here is the API documentation:
      ${api.documentation}
    `;

    const response = await openai.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt }, 
        { role: "user", content: [{ type: "text", text: prompt }] }
      ],
      model: "gpt-4o-mini",
      tools: GENERIC_API_TOOLS,
    });

    return response.choices[0].message;;
  } catch (error) {
    console.error('Error formulating api call to make:', error);
    return '';
  }
}

async function perform(apiCall) {
  try {
    console.log('apiCall', apiCall);
    const f = apiCall.tool_calls[0].function;
    console.log('f', f);
    const name = f.name;
    const args = JSON.parse(f.arguments);
    const path = args.path;

    if (name === 'http_get') {
      const url = `${api.baseUrl}/${path}`;
      const response = await fetch(url);
      return await response.json();
    } else {
      console.error('Usupported function:', name);
      return '';
    }
  } catch (error) {
    console.error('Error performing api call:', error);
  }
}

async function transformApiResponseToResponse(sessionId, prompt, apiCall, apiResponse) {
  try {
    const systemPromptMsg = {
      role: 'system', content: `You are an assistant that helps people with calling REST APIs of a specific service.
      You help translating from HTTP responses to human-readable responses. You generate plain text responses 
      that are easy to understand. No JSON, XML or MarkDown, just plain text.
    ` };

    const text = `I asked the following question: 

    ${prompt}
    
    I made the following API call:
    
    ${JSON.stringify(apiCall)}
    
    The API responded with:

    ${JSON.stringify(apiResponse)}

    Please help me translate this response to a human-readable response.
    `

    const messageToSend = { role: "user", content: [{ type: "text", text: text }] };
    const messages = [systemPromptMsg, messageToSend];
    const req = {
      messages: messages,
      model: "gpt-4o-mini"
    }
    console.log('req:', req);
    const response = await openai.chat.completions.create(req);

    const humanReadableResponse = response.choices[0].message;
    return humanReadableResponse.content;
  } catch (error) {
    console.error('Error formulating api call to make:', error);
    return '';
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
