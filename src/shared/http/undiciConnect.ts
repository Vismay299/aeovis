import type buildConnector from "undici/types/connector";

// The function undici's Agent accepts as `connect`: dial (and for https wrap)
// the socket itself, then hand it back.
export type Connector = ReturnType<typeof buildConnector>;
