// A chat's transcript is read from the server and then owned by the live chat, so
// the cached copy must never be served as fresh. The app-wide default is a
// five-minute staleTime, and `queryClient.fetchQuery` honours it: without these
// options the "reload the canonical transcript" call made when a reply finishes
// returned the copy cached when the page loaded and replaced the transcript with
// it, wiping the reply that had just streamed in. A session left and reopened
// would likewise open on a stale transcript, so nothing is kept once unobserved.
export const SESSION_DETAIL_CACHE = { staleTime: 0, gcTime: 0 } as const;
