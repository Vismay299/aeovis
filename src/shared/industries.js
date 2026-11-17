// Industry catalog. Each entry: display label + unbranded fallback prompts
// (last-resort top-up in promptGen when LLM/PAA passes come up short).
// Prompt style mirrors promptGen rules: lowercase, 3-9 words, natural search-bar
// phrasing, India-market flavor where it fits.
export const INDUSTRY_PROMPTS = {
  saas: {
    label: "SaaS",
    prompts: [
      "best project management software for startups",
      "what crm should i use for my small business",
      "top collaboration tools for remote teams",
      "cheapest saas tools for small teams india",
    ],
  },
  ecommerce: {
    label: "E-commerce",
    prompts: [
      "best platforms to start an online store",
      "top email marketing tools for ecommerce brands",
      "best payment gateway for small businesses india",
      "how to reduce cart abandonment online store",
    ],
  },
  finance: {
    label: "Finance",
    prompts: [
      "best accounting software for freelancers",
      "top personal finance apps for budgeting",
      "best investment platforms for beginners india",
      "how to file gst returns online easily",
    ],
  },
  agency: {
    label: "Agency",
    prompts: [
      "best digital marketing agencies for startups",
      "top web development companies for design",
      "best seo agency for local business growth",
      "how much does a marketing agency cost",
    ],
  },
  healthcare: {
    label: "Healthcare",
    prompts: [
      "best online doctor consultation apps india",
      "top clinic management software for doctors",
      "best health insurance plans for family",
      "how to book lab tests at home",
    ],
  },
  edtech: {
    label: "Education & EdTech",
    prompts: [
      "best online learning platforms for upskilling",
      "top coding courses for beginners india",
      "best learning management system for schools",
      "which online course is worth it 2026",
    ],
  },
  realestate: {
    label: "Real Estate",
    prompts: [
      "best websites to find flats for rent",
      "top real estate portals india",
      "how to verify property documents before buying",
      "best crm for real estate agents",
    ],
  },
  legal: {
    label: "Legal",
    prompts: [
      "best online legal services for startups",
      "how to register a company in india",
      "top contract management software small business",
      "cheapest way to trademark a brand name",
    ],
  },
  food: {
    label: "Food & Restaurants",
    prompts: [
      "best pos system for small restaurants",
      "top food delivery platforms for restaurants",
      "how to increase restaurant orders online",
      "best cloud kitchen software india",
    ],
  },
  travel: {
    label: "Travel & Hospitality",
    prompts: [
      "best websites to book cheap flights",
      "top hotel booking apps india",
      "best channel manager for small hotels",
      "how to plan a budget trip abroad",
    ],
  },
  fitness: {
    label: "Fitness & Wellness",
    prompts: [
      "best gym management software india",
      "top home workout apps free",
      "best protein supplements for beginners",
      "how to start online fitness coaching",
    ],
  },
  beauty: {
    label: "Beauty & Personal Care",
    prompts: [
      "best skincare brands for oily skin india",
      "top salon booking apps",
      "affordable makeup brands worth buying",
      "best hair care routine for hair fall",
    ],
  },
  fashion: {
    label: "Fashion & Apparel",
    prompts: [
      "best online clothing stores india",
      "top sustainable fashion brands affordable",
      "where to buy office wear for women",
      "best sneakers under 5000",
    ],
  },
  automotive: {
    label: "Automotive",
    prompts: [
      "best electric scooters in india 2026",
      "top car insurance providers online",
      "best website to buy used cars",
      "car service at home worth it",
    ],
  },
  logistics: {
    label: "Logistics & Shipping",
    prompts: [
      "best courier services for ecommerce india",
      "top shipping aggregators for small business",
      "cheapest way to ship products across india",
      "best fleet management software",
    ],
  },
  manufacturing: {
    label: "Manufacturing",
    prompts: [
      "best erp software for small manufacturers",
      "top inventory management systems factory",
      "how to find bulk raw material suppliers",
      "best cnc machine brands india",
    ],
  },
  construction: {
    label: "Construction & Building Materials",
    prompts: [
      "best tiles brands in india",
      "top cement brands for house construction",
      "how to estimate house construction cost",
      "best construction project management software",
    ],
  },
  hr: {
    label: "HR & Recruitment",
    prompts: [
      "best hr software for small companies india",
      "top job portals for hiring",
      "best payroll software for startups",
      "how to reduce employee attrition",
    ],
  },
  cybersecurity: {
    label: "Cybersecurity",
    prompts: [
      "best antivirus for small business",
      "top password managers 2026",
      "how to protect company from phishing",
      "best vpn for business use",
    ],
  },
  martech: {
    label: "Marketing & AdTech",
    prompts: [
      "best social media scheduling tools",
      "top email marketing software small business",
      "best analytics tools for websites free",
      "how to run google ads on small budget",
    ],
  },
  gaming: {
    label: "Gaming",
    prompts: [
      "best gaming laptops under 80000",
      "top mobile games india 2026",
      "best game engines for beginners",
      "how to start a gaming youtube channel",
    ],
  },
  media: {
    label: "Media & Entertainment",
    prompts: [
      "best ott platforms worth subscribing india",
      "top podcast hosting platforms free",
      "best video editing software for creators",
      "how to monetize a youtube channel",
    ],
  },
  telecom: {
    label: "Telecom",
    prompts: [
      "best prepaid plans with unlimited data",
      "top broadband providers for home india",
      "cheapest international roaming plans",
      "best cloud telephony services business",
    ],
  },
  insurance: {
    label: "Insurance",
    prompts: [
      "best term insurance plans india 2026",
      "top health insurance for senior citizens",
      "how to compare car insurance online",
      "is bike insurance renewal online safe",
    ],
  },
  retail: {
    label: "Retail",
    prompts: [
      "best billing software for retail shops india",
      "top inventory apps for kirana stores",
      "how to take my shop online",
      "best barcode scanner for small store",
    ],
  },
  agriculture: {
    label: "Agriculture",
    prompts: [
      "best drip irrigation systems for small farms",
      "top apps for farmers to sell produce",
      "best organic fertilizers for vegetables",
      "how to get agriculture loan india",
    ],
  },
  energy: {
    label: "Energy & Solar",
    prompts: [
      "best solar panels for home india",
      "how much does rooftop solar cost",
      "top inverter battery brands",
      "solar subsidy how to apply",
    ],
  },
  electronics: {
    label: "Consumer Electronics",
    prompts: [
      "best smartphones under 20000 india",
      "top wireless earbuds 2026",
      "best laptops for students budget",
      "which smart tv brand is most reliable",
    ],
  },
  homeservices: {
    label: "Home Services",
    prompts: [
      "best home cleaning services near me",
      "top interior designers affordable india",
      "how much does house painting cost",
      "best app to book electrician plumber",
    ],
  },
  nonprofit: {
    label: "Nonprofit & NGO",
    prompts: [
      "best fundraising platforms for ngos india",
      "top crm for nonprofits free",
      "how to register an ngo online",
      "best crowdfunding sites for social causes",
    ],
  },
};
