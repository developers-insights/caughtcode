const optional = (key: string): string | undefined => {
  const value = process.env[key]
  return value && value.length > 0 ? value : undefined
}

const required = (key: string): string => {
  const value = optional(key)
  if (!value) {
    throw new Error(
      `Falta la variable de entorno ${key}. Completala en .env.local (mirá .env.example).`,
    )
  }
  return value
}

export const env = {
  appUrl: () => optional('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000',

  supabaseUrl: () => required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: () => required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),

  encryptionKey: () => required('ENCRYPTION_KEY'),
  workerSecret: () => optional('WORKER_SECRET'),

  storageDir: () => optional('CAUGHTCODE_STORAGE_DIR'),
  grammarDir: () => optional('CAUGHTCODE_GRAMMAR_DIR'),
  cronSecret: () => optional('CRON_SECRET'),

  anthropicKey: () => required('ANTHROPIC_API_KEY'),
  anthropicModel: () => optional('ANTHROPIC_MODEL') ?? 'claude-sonnet-5',

  github: () => ({
    appId: optional('GITHUB_APP_ID'),
    slug: optional('GITHUB_APP_SLUG'),
    clientId: optional('GITHUB_APP_CLIENT_ID'),
    clientSecret: optional('GITHUB_APP_CLIENT_SECRET'),
    privateKey: optional('GITHUB_APP_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
    webhookSecret: optional('GITHUB_WEBHOOK_SECRET'),
  }),

  tts: () => ({
    provider: (optional('TTS_PROVIDER') ?? 'azure') as 'azure' | 'google' | 'none',
    azureKey: optional('AZURE_SPEECH_KEY'),
    azureRegion: optional('AZURE_SPEECH_REGION'),
    azureVoice: optional('AZURE_SPEECH_VOICE') ?? 'es-AR-TomasNeural',
    googleKey: optional('GOOGLE_TTS_API_KEY'),
  }),

  video: () => ({
    renderer: (optional('VIDEO_RENDERER') ?? 'web') as 'web' | 'remotion' | 'none',
    ffmpegPath: optional('FFMPEG_PATH'),
  }),

  stripe: () => ({
    secretKey: optional('STRIPE_SECRET_KEY'),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET'),
    priceAudit: optional('STRIPE_PRICE_AUDIT'),
    priceMonitoring: optional('STRIPE_PRICE_MONITORING'),
  }),

  isConfigured: (key: string) => Boolean(optional(key)),
}

export { optional as optionalEnv, required as requiredEnv }
