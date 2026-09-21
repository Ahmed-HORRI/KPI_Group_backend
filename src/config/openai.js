const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.SECRET_KEY
});

module.exports = openai;
