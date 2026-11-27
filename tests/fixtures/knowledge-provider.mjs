// Local Gemini transport fixture for browser tests. Uses only synthetic course material.
import { createServer } from "node:http";
createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const p = JSON.parse(input.contents[0].parts[0].text);
    const value = p.evidence
      ? {
          concepts: [
            {
              key: "chain",
              label: { ar: "قاعدة السلسلة", en: "Chain rule" },
              aliases: [],
              evidenceIds: [p.evidence[0].id],
            },
          ],
        }
      : { foundations: [], edges: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: JSON.stringify(value) }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { totalTokenCount: 80 },
      }),
    );
  } catch {
    res.writeHead(400);
    res.end();
  }
}).listen(43919, "127.0.0.1");
