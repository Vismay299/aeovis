#!/usr/bin/env node
/**
 * Test script for dynamic prompt generation (Phase 1)
 * 
 * Usage:
 *   npm run test:prompts -- --brand="Acme" --website="acme.com"
 *   npm run test:prompts -- --brand="Stripe" --website="stripe.com" --industry="saas"
 */

import { generatePromptsForBrand } from '../src/lib/prompts.js'; // ESM needs extension for direct node runs outside Next

// Note: When run via `npm run test:prompts`, --env-file=.env.local populates process.env before execution.
// No dotenv package required.

const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
};

const brand = getArg('brand') || 'TestBrand';
const website = getArg('website') || 'example.com';
const industry = getArg('industry') || 'saas';

console.log(`\n🔍 Testing dynamic prompt generation`);
console.log(`Brand: ${brand}`);
console.log(`Website: ${website}`);
console.log(`Industry: ${industry}`);
console.log(`Firecrawl key present: ${!!process.env.FIRECRAWL_API_KEY}`);
console.log(`Gemini key present: ${!!process.env.GEMINI_API_KEY}\n`);

try {
  const prompts = await generatePromptsForBrand(brand, website, industry);
  
  console.log(`✅ Generated ${prompts.length} prompts:\n`);
  
  prompts.slice(0, 10).forEach((p, i) => {
    console.log(`${i + 1}. ${p}`);
  });
  
  if (prompts.length > 10) {
    console.log(`... and ${prompts.length - 10} more`);
  }
  
  console.log(`\n🎉 Success! Dynamic prompts are working.`);
} catch (error) {
  console.error('❌ Test failed:', error.message);
  process.exit(1);
}
