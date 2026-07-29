const rateBuckets = new Map();
const concurrencyBuckets = new Map();

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

export function enforceRateLimit(request, scope, limit, windowMs = 60_000) {
  const now = Date.now();
  pruneRateBuckets(now);
  const key = `${scope}:${clientIp(request)}`;
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

export function acquireConcurrency(scope, maximum) {
  const active = concurrencyBuckets.get(scope) || 0;
  if (active >= maximum) return null;
  concurrencyBuckets.set(scope, active + 1);
  let released = false;
  return () => {
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
