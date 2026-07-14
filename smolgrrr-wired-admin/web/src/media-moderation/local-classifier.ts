import * as tf from "@tensorflow/tfjs";
import * as nsfw from "nsfwjs";
import sharp from "sharp";
import type { MediaAnalysisSignal } from "./contracts.js";

export type LocalMediaClassifier = {
  version: string;
  classify(bytes: Uint8Array): Promise<MediaAnalysisSignal[]>;
  close?: () => Promise<void> | void;
  warmup?: () => Promise<void>;
};

export function createNsfwJsClassifier(): LocalMediaClassifier {
  let modelPromise: ReturnType<typeof nsfw.load> | null = null;
  let classificationQueue: Promise<unknown> = Promise.resolve();

  function model() {
    modelPromise ??= nsfw.load();
    return modelPromise;
  }

  async function classifyNow(bytes: Uint8Array): Promise<MediaAnalysisSignal[]> {
    const { data, info } = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .removeAlpha()
      .resize(224, 224, { fit: "cover" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tensor = tf.tensor3d(
      new Uint8Array(data),
      [info.height, info.width, info.channels],
      "int32",
    );
    try {
      const predictions = (await (await model()).classify(tensor)) as Array<{
        className: string;
        probability: number;
      }>;
      return predictions.map((prediction) => ({
        category: prediction.className,
        confidence: prediction.probability,
        source: "model" as const,
      }));
    } finally {
      tensor.dispose();
    }
  }

  function classify(bytes: Uint8Array): Promise<MediaAnalysisSignal[]> {
    const next = classificationQueue.then(() => classifyNow(bytes));
    classificationQueue = next.catch(() => undefined);
    return next;
  }

  async function close(): Promise<void> {
    await classificationQueue;
    (await modelPromise)?.dispose();
    modelPromise = null;
  }

  async function warmup(): Promise<void> {
    const bytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    await classify(bytes);
  }

  return { version: "nsfwjs-mobilenet-v2-4.3.0", classify, close, warmup };
}
