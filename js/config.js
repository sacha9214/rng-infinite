/* RNG∞ — réglages publics partagés par le site (window.RNG_CONFIG) et les fonctions /api (require). */
(function (root) {
  'use strict';

  const env = typeof process !== 'undefined' && process.env ? process.env : {};

  const config = {
    // Identifiant OAuth "Web" de Google : public par nature, il part dans chaque page qui affiche le bouton.
    // Vide = connexion Google désactivée. Les tests le remplacent par GOOGLE_CLIENT_ID.
    // Créé le 2026-09-21 dans le projet Google Cloud « rng-infinite » (Google Auth Platform > Clients).
    googleClientId: env.GOOGLE_CLIENT_ID || '646300525529-ab8l5rqhnurlj8q7tv6bhf0c98nronn6.apps.googleusercontent.com',
    // Où tourne l'API. Tant que c'est l'adresse du site lui-même, tout passe par la copie hébergée avec lui.
    apiBase: 'https://rng-infinite.com',
    // Copie de secours (les fonctions hébergées avec le site), utilisée si apiBase ne répond pas.
    apiFallback: 'https://rng-infinite.com',
  };

  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.RNG_CONFIG = config;
})(typeof window !== 'undefined' ? window : globalThis);
