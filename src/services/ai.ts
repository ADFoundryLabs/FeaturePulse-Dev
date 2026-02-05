import dotenv from 'dotenv';

dotenv.config();

export interface AIAnalysisResult {
    score: number;
    decision: 'APPROVE' | 'WARN' | 'BLOCK';
    summary: string;
}

export async function analyzeWithAI(intent: string, diff: string): Promise<AIAnalysisResult> {
    if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("Missing OPENROUTER_API_KEY in .env");
    }

    const prompt = `
    You are FeaturePulse, a strict code guardian.
    
    GOAL: Compare the CODE DIFF against the PRODUCT INTENT.
    
    [PRODUCT INTENT]
    ${intent}
    
    [CODE DIFF]
    ${diff.substring(0, 5000)} ... (truncated if too long)
    
    INSTRUCTIONS:
    1. Analyze if the code aligns with the intent.
    2. Look for security risks or "scope creep" (features not asked for).
    3. Output a JSON object ONLY. No markdown formatting.
    
    JSON SCHEMA:
    {
        "score": number (0-100),
        "decision": "APPROVE" | "WARN" | "BLOCK",
        "summary": "A short, helpful explanation of why."
    }
    `;

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "google/gemini-2.0-flash-001", // Free & Fast model
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" } // Forces JSON output
            })
        });

        const data = await response.json();
        
        if (!data.choices || !data.choices[0]) {
            throw new Error("Invalid AI response structure");
        }

        const content = data.choices[0].message.content;
        return JSON.parse(content);

    } catch (error) {
        console.error("AI Analysis Failed:", error);
        // Fallback safe response so we don't crash
        return { score: 0, decision: 'WARN', summary: "AI Analysis failed. Please check logs." };
    }
}