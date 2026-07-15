// src/hooks/useProfile.js
//
// Deprecated location kept only so existing imports (`../../hooks/useProfile`)
// keep working — the real implementation now lives in
// `src/context/ProfileContext.jsx` as a single shared context, so every
// component sees the exact same role/loading/error state at the exact
// same time instead of each doing its own independent fetch.
//
// New code should import directly from '../context/ProfileContext'.
export { useProfile, hasRole } from '../context/ProfileContext'