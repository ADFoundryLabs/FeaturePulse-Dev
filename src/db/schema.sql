CREATE TABLE installations (
    id SERIAL PRIMARY KEY,
    github_installation_id BIGINT UNIQUE NOT NULL,
    account_name TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    intent_text TEXT,
    mode TEXT DEFAULT 'gatekeeper'
);
CREATE TABLE analysis_logs (
    id SERIAL PRIMARY KEY,
    installation_id INT REFERENCES installations(id),
    pr_number INT NOT NULL,
    commit_sha TEXT NOT NULL,
    decision TEXT NOT NULL,
    score INT,
    created_at TIMESTAMP DEFAULT NOW()
);