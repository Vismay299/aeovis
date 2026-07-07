# Antigravity AEO Visibility Tracker

A modern, agentic web application for tracking Answer Engine Optimization (AEO) visibility. This tool simulates the experience of a buyer asking an AI engine about your brand and your competitors, delivering actionable insights, prompt-level visibility scores, and strategic recommendations to improve your standing.

## Features

- **Dynamic Prompt Generation**: Automatically generates a robust list of industry-specific queries simulating how real users ask AI (e.g., "Best [Industry] tools for [Use Case]").
- **Live AI Probing**: Simulates search and LLM engines using a hybrid architecture: Google AI Overview (via SerpAPI), Perplexity, OpenAI, and Gemini.
- **Visibility Scoring**: Calculates a composite 0-100 Visibility Score based on whether the brand was mentioned, its recommendation position (Recommended: 1.0, Compared: 0.6, Cited: 0.3, Omitted: 0.0), sentiment (Positive: 1.0, Neutral: 0.5, Negative: 0.0), and a +0.15 score bonus (up to 15 points on the 100 scale) for brand domain citations. If Google AI Overview is active, a hybrid weight methodology is applied (50% Google AI Overview, 25% Perplexity, 15% ChatGPT, 10% Gemini).
- **Competitor Tracking**: Identifies the exact competitors stealing your share of voice on specific prompts.
- **Actionable Opportunities**: Uses LLM-driven insights to highlight high-potential visibility gaps and suggests strategic next steps to capture them.
- **Citations & Sources**: Aggregates the top domains cited by the AI to help you understand which sources influence the answer engine the most.
- **Historical Tracking**: Stores previous scans in Supabase, allowing you to track your visibility trend over time via an interactive sparkline and historical comparisons.

## Tech Stack

- **Framework**: Next.js (App Router)
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL)
- **AI Models**: Google Gemini (`gemini-2.5-flash-lite`, `gemini-2.5-flash` for extraction)
- **Icons**: Lucide React

## Setup Instructions

1. **Clone the repository**

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment Variables**
   Create a `.env.local` file in the root of your project:
   ```env
   # Google Gemini API Key for dynamic prompt generation and simulated answer engine responses
   GEMINI_API_KEY=your_gemini_api_key

   # OpenAI API Key for ChatGPT search engine simulation (Optional)
   OPENAI_API_KEY=your_openai_api_key

   # Perplexity API Key for Perplexity search engine simulation (Optional)
   PERPLEXITY_API_KEY=your_perplexity_api_key

   # SerpAPI Key for fetching Google AI Overviews (Optional)
   SERPAPI_KEY=your_serpapi_key

   # Location code for SerpAPI (default 'us')
   SERP_GEO=us

   # Device configuration for SerpAPI (default 'desktop')
   SERP_DEVICE=desktop

   # Probing mode configurations (default 'hybrid' if serpapi key present, else 'llm_only')
   # Options:
   # - hybrid: Google AI Overview + enabled LLMs
   # - llm_only: Only LLM engines (Gemini/OpenAI/Perplexity)
   # - serp_primary: Query Google AI Overview first; only fallback to LLMs on overview miss
   PROBE_MODE=hybrid

   # Comma-separated list of enabled simulation engines
   # Options: gemini, openai, perplexity, google_ai_overview
   ENGINES_ENABLED=google_ai_overview,gemini,openai,perplexity

   # Supabase Configuration for history tracking
   NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

   # Number of probe runs per prompt to reduce answer variance (default is 3, set to 1 for faster local dev scans)
   PROBE_RUNS=1
   ```
   *(Note: The app is designed to degrade gracefully if Supabase is not configured, disabling the history features but retaining the core scanning functionality).*

4. **Run the Development Server**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Database Schema (Supabase)

If you are setting up Supabase, execute the following SQL scripts in your Supabase SQL Editor:

```sql
-- 1. Scans Table (core results)
CREATE TABLE scans (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  brand text NOT NULL,
  url text,
  industry text,
  platform text,
  visibility_pct numeric,
  prompts_tracked integer,
  prompts_mentioned integer,
  competitors jsonb,
  scanned_at timestamptz,
  used_dynamic_prompts boolean,
  raw_results jsonb,
  competitors_raw text,
  scoring_version text,
  score_ci_low numeric,
  score_ci_high numeric,
  stability text,
  mention_rate_pct numeric
);

-- 2. Brand Prompts Table (persistent prompt caching)
CREATE TABLE brand_prompts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  text text NOT NULL,
  intent_tier text NOT NULL,
  topic text,
  weight numeric DEFAULT 1.0,
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT brand_prompts_brand_text_idx UNIQUE (brand, text)
);

-- 3. Scan Jobs Table (async pipeline tracking)
CREATE TABLE scan_jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  url text,
  industry text,
  competitors text,
  status text NOT NULL,
  progress_pct integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  result_id uuid REFERENCES scans(id) ON DELETE SET NULL,
  error_message text,
  run_record jsonb
);
```

## Features

- **Statistical Rigor**: Probes each query multiple times (configurable via `PROBE_RUNS`) and computes the median score, standard deviation, and confidence intervals to ensure highly stable AEO measurements.
- **Persistent Prompt Sets**: Caches generated prompts in the database to guarantee historical score trends are completely comparable.
- **Buyer Intent Weighting**: Computes the overall Visibility Score as an intent-weighted average: High Intent (3.0x), Comparison (2.0x), Problem Aware (1.5x), Exploratory (1.0x), and Branded (0.5x).
- **Interactive Query Manager**: Add custom user questions and toggle enable/disable states for any tracked query in real time.

## Project Structure

---
Built with Antigravity 2.0.
