const { GoogleGenAI } = require('@google/genai');

function getGeminiApiKey() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured.',
    );
  }

  return apiKey;
}

function getGeminiModel() {
  return (
    process.env.GEMINI_MODEL ||
    'gemini-3.1-flash-lite'
  );
}

function createGeminiClient() {
  return new GoogleGenAI({
    apiKey: getGeminiApiKey(),
  });
}

module.exports = {
  createGeminiClient,
  getGeminiModel,
};