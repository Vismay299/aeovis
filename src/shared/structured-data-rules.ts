// Structured-data required-property rules dated October 2026.
// Google search rich result guidelines. Only exact type names are checked.

export const STRUCTURED_DATA_REQUIRED: Record<string, Array<string | string[]>> = {
  Organization: ["name", "url"],
  LocalBusiness: ["name", "address"],
  Product: ["name", ["offers", "review", "aggregateRating"]],
  Article: ["headline"],
  NewsArticle: ["headline"],
  BlogPosting: ["headline"],
  FAQPage: ["mainEntity"],
  BreadcrumbList: ["itemListElement"],
  WebSite: ["name", "url"],
  Event: ["name", "startDate", "location"],
  Recipe: ["name", "image"],
  Review: ["itemReviewed", "author"],
  JobPosting: ["title", "description", "datePosted", "hiringOrganization"],
  VideoObject: ["name", "thumbnailUrl", "uploadDate"],
};
