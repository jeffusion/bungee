import { writable } from 'svelte/store';

/**
 * LocalStorage key for storing the auth token
 */
const TOKEN_KEY = 'bungee_auth_token';

/**
 * Token state - stores the current authentication token
 */
export const token = writable<string | null>(
  typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null
);

/**
 * Authentication status - whether the user is currently authenticated
 */
export const isAuthenticated = writable<boolean>(
  typeof window !== 'undefined' ? !!localStorage.getItem(TOKEN_KEY) : false
);

/**
 * Authentication requirement - whether authentication is enabled in config
 */
export const authRequired = writable<boolean>(false);

/**
 * Login with a token
 * Saves the token to localStorage and updates the auth state
 *
 * @param newToken - The authentication token to save
 */
export function login(newToken: string): void {
  if (typeof window === 'undefined') return;

  localStorage.setItem(TOKEN_KEY, newToken);
  token.set(newToken);
  isAuthenticated.set(true);
}

/**
 * Logout
 * Clears the token from localStorage and resets the auth state
 */
export function logout(): void {
  if (typeof window === 'undefined') return;

  localStorage.removeItem(TOKEN_KEY);
  token.set(null);
  isAuthenticated.set(false);
}

/**
 * Get the current token from localStorage
 *
 * @returns The current token, or null if not authenticated
 */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;

  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Check if there's a token in localStorage and update the auth state
 * This is useful for initializing the auth state on app start
 */
export function checkAuth(): void {
  if (typeof window === 'undefined') return;

  const currentToken = localStorage.getItem(TOKEN_KEY);
  token.set(currentToken);
  isAuthenticated.set(!!currentToken);
}
