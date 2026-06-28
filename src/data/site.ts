// Central site configuration. Edit the values marked TODO before deploying.
export const SITE = {
  name: 'Fauzan Qadri',
  role: 'Backend & Distributed Systems Consultant',
  // One-line value proposition shown in the hero.
  tagline:
    'I help teams design and ship reliable payment, lending, and data platforms.',

  // Public contact email (also listed on the public LinkedIn profile).
  email: 'ojankill@gmail.com',

  // TODO: set your real domain (also update `site` in astro.config.mjs).
  url: 'https://example.com',

  // Handles. Leave a value empty ('') to hide that link.
  social: {
    github: '',
    linkedin: 'fauzan-qadri-9a3b5860',
    twitter: '',
  },

  nav: [
    { label: 'Work', href: '/work' },
    { label: 'Blog', href: '/blog' },
    { label: 'CV', href: '/cv' },
  ],
} as const;

export type SocialKey = keyof typeof SITE.social;
