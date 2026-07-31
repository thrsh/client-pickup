// src/lib/password.js
//
// Shared password rules for every "change password" form in the app
// (verifier, approver, admin). Keeping the rules in one place means the
// UI hint text and the actual pass/fail check can never drift apart.

export const PASSWORD_RULES = [
  {
    id: 'length',
    label: 'At least 10 characters',
    test: (pw) => pw.length >= 10,
  },
  {
    id: 'upper',
    label: 'One uppercase letter (A-Z)',
    test: (pw) => /[A-Z]/.test(pw),
  },
  {
    id: 'lower',
    label: 'One lowercase letter (a-z)',
    test: (pw) => /[a-z]/.test(pw),
  },
  {
    id: 'number',
    label: 'One number (0-9)',
    test: (pw) => /[0-9]/.test(pw),
  },
  {
    id: 'special',
    label: 'One special character (!@#$%^&*...)',
    test: (pw) => /[^A-Za-z0-9]/.test(pw),
  },
  {
    id: 'noSpaces',
    label: 'No leading/trailing spaces',
    test: (pw) => pw.trim() === pw && pw.length > 0,
  },
]

// Returns { passed: string[], failed: string[], score: 0-5, label, isValid }
export function evaluatePassword(pw = '', { currentPassword = '' } = {}) {
  const results = PASSWORD_RULES.map((rule) => ({
    ...rule,
    ok: rule.test(pw),
  }))

  const score = results.filter((r) => r.ok).length
  const reusesCurrent = currentPassword.length > 0 && pw === currentPassword

  let label = 'Too weak'
  if (score >= 6) label = 'Strong'
  else if (score >= 4) label = 'Fair'
  else if (score >= 2) label = 'Weak'

  return {
    results,
    score, // out of 6
    label,
    reusesCurrent,
    isValid: score === PASSWORD_RULES.length && !reusesCurrent,
  }
}

// Generates a password that always satisfies every rule above.
export function generateStrongPassword(length = 14) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O to avoid confusion
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const numbers = '23456789'
  const special = '!@#$%^&*_-+='
  const all = upper + lower + numbers + special

  const pick = (set) => set[Math.floor(Math.random() * set.length)]

  const required = [pick(upper), pick(lower), pick(numbers), pick(special)]
  const rest = Array.from({ length: Math.max(length - required.length, 0) }, () =>
    pick(all)
  )

  // Shuffle so the required characters aren't always in the same spot.
  const chars = [...required, ...rest]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

export function isValidEmail(email = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}