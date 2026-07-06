# Antigravity AEO Visibility Tracker

A modern, agentic web application for tracking Answer Engine Optimization (AEO) visibility. This tool simulates the experience of a buyer asking an AI engine about your brand and your competitors, delivering actionable insights, prompt-level visibility scores, and strategic recommendations to improve your standing.

## Features

- **Dynamic Prompt Generation**: Automatically generates a robust list of industry-specific queries simulating how real users ask AI (e.g., "Best [Industry] tools for [Use Case]").
- **Live AI Probing**: Uses Google Gemini to act as an Answer Engine, evaluating how often your brand is recommended natively vs. omitted.
- **Visibility Scoring**: Calculates a composite 0-100 Visibility Score based on whether the brand was mentioned, its recommendation position (Recommended: 1.0, Compared: 0.6, Cited: 0.3, Omitted: 0.0), sentiment (Positive: 1.0, Neutral: 0.5, Negative: 0.0), and a +0.15 score bonus (up to 15 points on the 100 scale) for brand domain citations.
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

If you are setting up Supabase, create a table named `scans` with the following schema:

- `id`: uuid (primary key)
- `created_at`: timestampz
- `brand`: text
- `url`: text
- `industry`: text
- `platform`: text
- `visibility_pct`: numeric
- `prompts_tracked`: integer
- `prompts_mentioned`: integer
- `competitors`: jsonb (Array of strings)
- `results`: jsonb (Optional: Array of extracted result objects if not using `raw_results`)
- `scanned_at`: timestampz
- `used_dynamic_prompts`: boolean
- `raw_results`: jsonb (Array of detailed extracted prompt analysis objects)
- `competitors_raw`: text (Original user input)

## Features

- **Statistical Rigor**: Probes each query multiple times (configurable via `PROBE_RUNS`) and computes the median score, standard deviation, and confidence intervals to ensure highly stable AEO measurements.
- **Persistent Prompt Sets**: Caches generated prompts in the database to guarantee historical score trends are completely comparable.
- **Buyer Intent Weighting**: Computes the overall Visibility Score as an intent-weighted average: High Intent (3.0x), Comparison (2.0x), Problem Aware (1.5x), Exploratory (1.0x), and Branded (0.5x).
- **Interactive Query Manager**: Add custom user questions and toggle enable/disable states for any tracked query in real time.

## Project Structure

---
Built with Antigravity 2.0.
