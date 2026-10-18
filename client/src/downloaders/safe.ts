// Stores map characters outside [a-zA-Z0-9_-] in release IDs and channel names to "_"
export const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
