// Merging the headers of a fetch call, whichever of the two forms the caller
// used: fetch(url, {headers}) or fetch(requestLike).
//
// Extracted from adminAuth.js because it was silently broken: the original
// expression `init.headers ?? (typeof input === 'object' && input?.headers) ?? undefined`
// evaluates its middle term to the BOOLEAN false for a string URL, and `??`
// only falls through on null/undefined — so `new Headers(false)` threw and
// every header-less GET to the agent server failed.
export function buildHeaders(input, init = {}) {
  const fromInit = init?.headers
  const fromInput = input && typeof input === 'object' ? input.headers : undefined
  return new Headers(fromInit ?? fromInput ?? undefined)
}
