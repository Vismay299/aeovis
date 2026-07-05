# Antigravity AEO Visibility Tracker

A modern, agentic web application for tracking Answer Engine Optimization (AEO) visibility. This tool simulates the experience of a buyer asking an AI engine about your brand and your competitors, delivering actionable insights, prompt-level visibility scores, and strategic recommendations to improve your standing.

## Features

- **Dynamic Prompt Generation**: Automatically generates a robust list of industry-specific queries simulating how real users ask AI (e.g., "Best [Industry] tools for [Use Case]").
- **Live AI Probing**: Uses Google Gemini to act as an Answer Engine, evaluating how often your brand is recommended natively vs. omitted.
- **Visibility Scoring**: Calculates a normalized 0-100 Visibility Score based on co-mentions, sentiment, and rank position.
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

## Project Structure

- `src/app`: Next.js App Router pages (Dashboard, Scan initialization, API routes).
- `src/components`: UI components including the Dashboard tabs (`TopPromptsTable`, `CompetitorTable`, `InsightPanel`, `OpportunitiesPanel`, `CitationsPanel`).
- `src/lib`: Core utilities for interacting with Gemini (`gemini.js`), Supabase (`db.js`), and prompt generation (`prompts.js`).
- `src/services`: Normalization logic mapping API responses to frontend component requirements (`api.js`).

## Roadmap / Nice-to-haves
- **Custom Prompts**: Add UI to disable tracked prompts or inject custom specific queries to track over time.
- **Batch Processing**: Further optimize the parallel execution of LLM tasks.
- **Shareable Reports**: Generate a public read-only link for a specific scan.

---
Built with Antigravity 2.0.
