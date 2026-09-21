const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.SECRET_KEY
});

const getOpenAIClient = () => {
  if (!process.env.SECRET_KEY) {
    throw new Error("OpenAI API key is not configured");
  }

  return new OpenAI({
    apiKey: process.env.SECRET_KEY,
  });
};

module.exports = { openai, getOpenAIClient };
