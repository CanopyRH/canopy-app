import Anthropic from "@anthropic-ai/sdk";
import { Classification, Label, buildPrompt, parseClassification } from "./llmClassify";

export const MODEL = "claude-opus-5-5";

const SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", enum: Label.options },
    protocol: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["label", "protocol", "confidence"],
  additionalProperties: false,
};

export type Classify = (source: string, text: string) => Promise<Classification | null>;

/** Labels public text. A refusal, an API failure or a malformed reply is null, which produces no signal. */
export function claudeClassifier(client: Pick<Anthropic, "beta">, model = MODEL, direct = true): Classify {
  return async (source, text) => {
    try {
      const res = await client.beta.messages.create({
        model,
        max_tokens: 1024,
        ...(direct ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: buildPrompt(source, text) }],
      });
      if (res.stop_reason === "refusal") return null;
      const block = res.content.find((b) => b.type === "text");
      return block && block.type === "text" ? parseClassification(block.text) : null;
    } catch {
      return null;
    }
  };
}

/** With a base URL the calls go through a compatible service such as PPQ, which has its own model names. Refusal fallbacks are Anthropic's, so they stay off there. */
export function classifierFor(apiKey: string, baseURL?: string, model = MODEL): Classify {
  return claudeClassifier(new Anthropic({ apiKey, baseURL }), model, !baseURL);
}
