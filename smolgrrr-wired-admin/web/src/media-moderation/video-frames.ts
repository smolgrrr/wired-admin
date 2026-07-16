import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

async function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(
          new Error(
            `${command} failed${stderr.length ? `: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}` : ""}`,
          ),
        );
      }
    });
  });
}

export async function extractRepresentativeVideoFrames(
  bytes: Uint8Array,
  {
    frameCount = 5,
    maxDurationSeconds = 600,
    timeoutMs = 12_000,
  }: {
    frameCount?: number;
    maxDurationSeconds?: number;
    timeoutMs?: number;
  } = {},
): Promise<Buffer[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-media-video-"));
  const input = path.join(directory, "source.bin");
  const output = path.join(directory, "frame-%02d.jpg");
  try {
    await writeFile(input, bytes);
    const durationOutput = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        input,
      ],
      Math.min(timeoutMs, 4_000),
    );
    const duration = Number(durationOutput.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("invalid video duration");
    if (duration > maxDurationSeconds) throw new Error("video exceeds duration limit");
    const framesPerSecond = Math.max(0.02, frameCount / duration);
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        input,
        "-vf",
        `fps=${framesPerSecond},scale=640:640:force_original_aspect_ratio=decrease`,
        "-frames:v",
        String(frameCount),
        "-q:v",
        "3",
        output,
      ],
      timeoutMs,
    );
    const files = (await readdir(directory))
      .filter((file) => /^frame-\d+\.jpg$/.test(file))
      .sort()
      .slice(0, frameCount);
    if (files.length < 2) throw new Error("video did not yield representative frames");
    return Promise.all(files.map((file) => readFile(path.join(directory, file))));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
