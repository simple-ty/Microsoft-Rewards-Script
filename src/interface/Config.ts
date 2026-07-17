export interface Config {
    baseURL: string
    sessionPath: string
    headless: boolean
    clusters: number
    errorDiagnostics: boolean
    ensureStreakProtection: boolean
    workers: ConfigWorkers
    searchOnBingLocalQueries: boolean
    globalTimeout: number | string
    searchSettings: ConfigSearchSettings
    debugLogs: boolean
    proxy: ConfigProxy
    consoleLogFilter: LogFilter
    webhook: ConfigWebhook
}

export type QueryEngine = 'china' | 'google' | 'wikipedia' | 'reddit' | 'local'

export interface ConfigSearchSettings {
    scrollRandomResults: boolean
    clickRandomResults: boolean
    parallelSearching: boolean
    queryEngines: QueryEngine[]
    searchResultVisitTime: number | string
    searchDelay: ConfigDelay
    readDelay: ConfigDelay
    /**
     * 中国热搜源（gmya.net）配置。
     * appkey 留空走免费档（有频率限制）；填入则带 appkey 请求以解除限流。
     */
    chinaApi?: {
        appkey?: string
    }
}

export interface ConfigDelay {
    min: number | string
    max: number | string
}

export interface ConfigProxy {
    queryEngine: boolean
}

export interface ConfigWorkers {
    doDailySet: boolean
    doSpecialPromotions: boolean
    doMorePromotions: boolean
    doClaimBonusPoints: boolean
    doPunchCards: boolean
    doAppPromotions: boolean
    doDesktopSearch: boolean
    doMobileSearch: boolean
    doDailyCheckIn: boolean
    doReadToEarn: boolean
}

// Webhooks
export interface ConfigWebhook {
    pushplus?: WebhookPushPlusConfig
    webhookLogFilter: LogFilter
}

export interface LogFilter {
    enabled: boolean
    mode: 'whitelist' | 'blacklist'
    levels?: Array<'debug' | 'info' | 'warn' | 'error'>
    keywords?: string[]
    regexPatterns?: string[]
}

export interface WebhookPushPlusConfig {
    enabled?: boolean
    token: string
    title?: string
    template?: 'txt' | 'html' | 'markdown'
    channel?: string
}
