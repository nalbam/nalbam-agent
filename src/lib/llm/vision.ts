/**
 * Vision helper — describes an image with the configured text model.
 *
 * Uses Vercel AI SDK's multimodal message format. The text model must
 * support image input (gpt-4o / gpt-4o-mini / Claude 3+ on Bedrock).
 *
 * The agent's read_attached_images tool calls this so a single LLM hop
 * per image returns a textual description the loop can reason about.
 */
import { generateText } from "ai";

import { getServerEnv } from "@/lib/env";
import { getTextModelFromEnv } from "@/lib/llm/factory";

const DESCRIBE_PROMPT: Record<"ko" | "en", string> = {
  ko: "이 이미지를 자세히 묘사해줘. 보이는 객체, 텍스트, 핵심 정보를 모두 포함해.",
  en: "Describe this image in detail. Include all visible objects, text, and key information.",
};

export interface DescribeImageInput {
  /** Raw image bytes. */
  data: Uint8Array;
  /** MIME type — e.g. image/png, image/jpeg. */
  mediaType: string;
}

export const describeImage = async ({ data, mediaType }: DescribeImageInput): Promise<string> => {
  const env = getServerEnv();
  const prompt = DESCRIBE_PROMPT[env.RESPONSE_LANGUAGE];
  const { text } = await generateText({
    model: getTextModelFromEnv(),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", image: data, mediaType },
        ],
      },
    ],
  });
  return text.trim();
};
