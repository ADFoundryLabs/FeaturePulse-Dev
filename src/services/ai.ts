import dotenv from 'dotenv';

dotenv.config();

export interface AIAnalysisResult {
    score: number;
    decision: 'APPROVE' | 'WARN' | 'BLOCK';
    summary: string;
}

// ---------------------------------------------------------------------------
// Phase 2 Fix 1: Secret scrubbing
// Redact common secret patterns before the diff is sent to an external AI
// provider. Each pattern is replaced with a placeholder so the AI still sees
// the structural context (e.g. an assignment) but never the credential value.
// Patterns covered:
//   - AWS access key IDs  (AKIA…)
//   - AWS secret access keys (long base64-ish strings after common key names)
//   - Generic bearer / API-key header values
//   - Password / secret / token assignments  (key=value, key: "value", etc.)
// ---------------------------------------------------------------------------
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
    // AWS Access Key ID
    {
        pattern: /(AKIA[0-9A-Z]{16})/g,
        replacement: '[REDACTED_AWS_KEY_ID]',
    },
    // AWS Secret Access Key (40-char base64-safe string following common key names)
    {
        pattern: /(aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(["']?)/gi,
        replacement: '$1[REDACTED_AWS_SECRET]$2',
    },
    // Bearer tokens in Authorization headers
    {
        pattern: /(Authorization\s*:\s*["']?Bearer\s+)[A-Za-z0-9._\-+/=]{20,}(["']?)/gi,
        replacement: '$1[REDACTED_BEARER_TOKEN]$2',
    },
    // Generic API key / token / password assignments  (covers JSON, YAML, .env, code)
    {
        pattern: /((api[_-]?key|apikey|api[_-]?token|access[_-]?token|secret|password|passwd|auth[_-]?token)\s*[:=]\s*["']?)[^\s"'`\]},]{8,}(["'`]?)/gi,
        replacement: '$1[REDACTED]$3',
    },
];

/**
 * scrubSecrets
 * Returns a copy of `text` with recognisable secret patterns replaced by
 * redaction placeholders. The caller is responsible for using the return
 * value; the original string is never mutated.
 */
function scrubSecrets(text: string): string {
    let scrubbed = text;
    for (const { pattern, replacement } of SECRET_PATTERNS) {
        scrubbed = scrubbed.replace(pattern, replacement);
    }
    return scrubbed;
}

// ---------------------------------------------------------------------------
// Phase 2 Fix 2 (OpenRouter): Exponential backoff for fetch()
// Retries on HTTP 429 (rate-limited) or 5xx (transient server errors).
// The AbortController timeout from Phase 1 Fix 3 is preserved per attempt so
// a single hung request never exceeds 25 s regardless of retry count.
// ---------------------------------------------------------------------------
const OPENROUTER_MAX_RETRIES = 4;
const OPENROUTER_BASE_DELAY_MS = 500; // doubles each attempt: 500 → 1000 → 2000 → 4000

async function fetchWithBackoff(
    url: string,
    options: RequestInit,
    attempt = 0
): Promise<Response> {
    // Each attempt gets its own timeout controller so a 25 s limit applies
    // independently of the retry delay.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25_000);

    let response: Response;
    try {
        response = await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }

    const isRateLimited = response.status === 429;
    const isServerError = response.status >= 500 && response.status < 600;

    if ((isRateLimited || isServerError) && attempt < OPENROUTER_MAX_RETRIES) {
        // Respect Retry-After header when present (value in seconds)
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader
            ? parseFloat(retryAfterHeader) * 1_000
            : OPENROUTER_BASE_DELAY_MS * Math.pow(2, attempt);

        console.warn(
            `OpenRouter responded with ${response.status}. ` +
            `Retrying in ${Math.round(retryAfterMs)}ms (attempt ${attempt + 1}/${OPENROUTER_MAX_RETRIES}).`
        );

        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        return fetchWithBackoff(url, options, attempt + 1);
    }

    return response;
}

export async function analyzeWithAI(intent: string, diff: string): Promise<AIAnalysisResult> {
    if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("Missing OPENROUTER_API_KEY in .env");
    }

    // Phase 2 Fix 1: scrub secrets from the diff before it is sent externally.
    const safeDiff = scrubSecrets(diff);

    // Phase 2 Fix 4: only append the truncation notice when the diff actually
    // exceeds the character limit (previously it was always appended).
    const DIFF_CHAR_LIMIT = 5000;
    const truncated = safeDiff.length > DIFF_CHAR_LIMIT;
    const diffForPrompt = truncated
        ? `${safeDiff.substring(0, DIFF_CHAR_LIMIT)}\n... (truncated — full diff is ${safeDiff.length} chars; only first ${DIFF_CHAR_LIMIT} chars sent. Chunked analysis is a known limitation.)`
        : safeDiff;

    const prompt = `
    You are FeaturePulse, a strict code guardian.
    
    GOAL: Compare the CODE DIFF against the PRODUCT INTENT.
    
    [PRODUCT INTENT]
    ${intent}
    
    [CODE DIFF]
    ${diffForPrompt}
    
    INSTRUCTIONS:
    1. Analyze if the code aligns with the intent.
    2. Look for security risks or "scope creep" (features not asked for).
    3. CRITICAL: If the PRODUCT INTENT specifies exact rules to BLOCK a PR (e.g., counting a specific word), you MUST evaluate them precisely. If violated, output "decision": "BLOCK".
    4. Output a JSON object ONLY. No markdown formatting.

    
    JSON SCHEMA:
    {
        "score": number (0-100),
        "decision": "APPROVE" | "WARN" | "BLOCK",
        "summary": "A short, helpful explanation of why."
    }
    `;

    try {
        // Phase 2 Fix 2: use fetchWithBackoff instead of bare fetch() so
        // OpenRouter 429 / 5xx responses are retried with exponential backoff.
        const response = await fetchWithBackoff(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "cohere/north-mini-code:free", // Free & Fast model
                    messages: [{ role: "user", content: prompt }],
                    response_format: { type: "json_object" } // Forces JSON output
                }),
            }
        );

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(`OpenRouter API Error (${response.status}): ${JSON.stringify(data)}`);
        }
        
        if (!data.choices || !data.choices[0]) {
            throw new Error("Invalid AI response structure: " + JSON.stringify(data));
        }

        const content = data.choices[0].message.content;
        return JSON.parse(content);

    } catch (error) {
        console.error("AI Analysis Failed:", error);
        // Fallback safe response so we don't crash
        return { score: 0, decision: 'WARN', summary: "AI Analysis failed. Please check logs." };
    }
}