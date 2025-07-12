const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.chat = async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // Xây dựng context prompt
    const chatContext = [
      { role: "user", parts: [{ text: "Bạn là SolaceBot - trợ lý tâm lý. Hãy lắng nghe và đưa ra lời khuyên tích cực." }] },
      ...history.map(msg => ({
        role: msg.role,
        parts: Array.isArray(msg.parts)
          ? msg.parts.map(p => (typeof p === "string" ? { text: p } : p))
          : [{ text: typeof msg.parts === "string" ? msg.parts : msg.text }]
      })),
      { role: "user", parts: [{ text: message }] }
    ];

    const result = await model.generateContent({ contents: chatContext });
    const response = result.response.text();

    res.json({ reply: response });
  } catch (error) {
    console.error("Gemini error:", error);
    res.status(500).json({ error: "AI service unavailable" });
  }
}; 