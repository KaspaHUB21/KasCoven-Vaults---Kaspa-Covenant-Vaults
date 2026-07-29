import { createClient } from "redis";

const rateBuckets = new Map();
const concurrencyBuckets = new Map();
let redisPromise = null;

function redisClient() {
  if (!process.env.REDIS_URL) return null;
  if (!redisPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", () => {});
    redisPromise = client.connect()
      .then(() => client)
      .catch(() => {
        redisPromise = null;
        return null;
      });
  }
  return redisPromise;
}

function clientIp(request) {
  return (
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function pruneRateBuckets(now) {
  if (rateBuckets.size < 2_000) return;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

export async function enforceRateLimit(request, scope, limit, windowMs = 60_000) {
  const now = Date.now();
  const key = `${scope}:${clientIp(request)}`;
  const redis = await redisClient();
  if (redis) {
    try {
      const [count, ttl] = await redis.eval(
        "local c=redis.call('INCR',KEYS[1]); if c==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); end; return {c,redis.call('PTTL',KEYS[1])}",
        { keys: [`kascoven:rate:${key}`], arguments: [String(windowMs)] },
      );
      if (Number(count) <= limit) return null;
      return Response.json(
        { error: "Too many requests. Wait before trying again." },
        {
          status: 429,
          headers: { "retry-after": String(Math.max(1, Math.ceil(Number(ttl) / 1000))) },
        },
      );
    } catch {
      // Preserve availability with the local limiter if Redis is temporarily unavailable.
    }
  }

  pruneRateBuckets(now);
  const current = rateBuckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (bucket.count <= limit) return null;
  return Response.json(
    { error: "Too many requests. Wait before trying again." },
    {
      status: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))) },
    },
  );
}

export async function acquireConcurrency(scope, maximum) {
  const redis = await redisClient();
  if (redis) {
    try {
      const key = `kascoven:concurrency:${scope}`;
      const acquired = await redis.eval(
        "local c=redis.call('INCR',KEYS[1]); if c==1 then redis.call('PEXPIRE',KEYS[1],ARGV[2]); end; if c>tonumber(ARGV[1]) then redis.call('DECR',KEYS[1]); return 0; end; return 1",
        { keys: [key], arguments: [String(maximum), "60000"] },
      );
      if (!Number(acquired)) return null;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await redis.eval(
          "local c=tonumber(redis.call('GET',KEYS[1]) or '0'); if c<=1 then redis.call('DEL',KEYS[1]); else redis.call('DECR',KEYS[1]); end; return 1",
          { keys: [key], arguments: [] },
        ).catch(() => null);
      };
    } catch {
      // Preserve availability with the local limiter if Redis is temporarily unavailable.
    }
  }

  const active = concurrencyBuckets.get(scope) || 0;
  if (active >= maximum) return null;
  concurrencyBuckets.set(scope, active + 1);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (concurrencyBuckets.get(scope) || 1) - 1);
    if (next) concurrencyBuckets.set(scope, next);
    else concurrencyBuckets.delete(scope);
  };
}

export function enforceSameOrigin(request) {
  const configuredToken = process.env.KASCOVEN_API_TOKEN;
  const suppliedToken = request.headers.get("x-kascoven-api-token");
  if (configuredToken && suppliedToken === configuredToken) return null;

  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!origin || !host) {
    return Response.json({ error: "A same-origin browser request is required." }, { status: 403 });
  }

  try {
    if (new URL(origin).host === host) return null;
  } catch {
    // Reject malformed origins below.
  }
  return Response.json({ error: "Cross-origin transaction relay requests are not allowed." }, { status: 403 });
}

export async function readJsonBody(request, maximumBytes = 1_000_000) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    const error = new Error("Request body is too large.");
    error.status = 413;
    throw error;
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    const error = new Error("Request body is too large.");
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Request body must contain valid JSON.");
    error.status = 400;
    throw error;
  }
}
