import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'

import { Logger } from './logging/Logger'
import Utils from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'
import { checkNodeVersion } from './util/Validator'

import { Login } from './browser/auth/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'

import type { Account } from './interface/Account'
import AxiosClient from './util/Axios'
import { sendPushPlus, flushPushPlusQueue } from './logging/PushPlus'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'
import { PanelFlyoutData } from './interface/PanelFlyoutData'
interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as Account }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await flushPushPlusQueue(timeoutMs)
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    timezoneOffset: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

// 主要的微软奖励机器人类，负责协调整个积分收集过程
export class MicrosoftRewardsBot {
    public logger: Logger // 日志记录器
    public config // 配置对象
    public utils: Utils // 工具类实例
    public activities: Activities = new Activities(this) // 活动管理器
    public browser: { func: BrowserFunc; utils: BrowserUtils } // 浏览器功能和工具

    public mainMobilePage!: Page // 主要的移动端页面
    public mainDesktopPage!: Page // 主要的桌面端页面

    public userData: UserData // 用户数据
    public panelData!: PanelFlyoutData

    public rewardsVersion: 'legacy' | 'modern' = 'legacy'

    public accessToken = '' // 访问令牌
    public requestToken = '' // 请求令牌
    public cookies: { mobile: Cookie[]; desktop: Cookie[] } // 移动端和桌面端的cookies
    public fingerprint!: BrowserFingerprintWithHeaders // 浏览器指纹

    // 新版 UI（modern dashboard）使用 Next.js Server Actions 而非 REST API。
    // next-action hash 在编译时生成，绑定到具体部署版本（dpl）。
    // 这里记录当前抓取到的部署 ID，用于在调用前做版本守卫。
    public serverActions: {
        deploymentId: string | null // 从 dashboard HTML 提取的 dpl（如 "20260612-3"）
    } = { deploymentId: null }

    private pointsCanCollect = 0 // 可收集的积分

    private activeWorkers: number // 活跃的工作进程数
    private exitedWorkers: number[] // 已退出的工作进程PID数组
    private browserFactory: Browser = new Browser(this) // 浏览器工厂实例
    private accounts: Account[] // 账户数组
    private workers: Workers // 工作进程管理器
    private login = new Login(this) // 登录管理器
    private searchManager: SearchManager // 搜索管理器

    public axios!: AxiosClient // HTTP客户端

    constructor() {
        // 初始化用户数据
        this.userData = {
            userName: '', // 用户名
            geoLocale: 'CN', // 地理区域
            langCode: 'zh', // 语言代码
            timezoneOffset: '480', // 时区偏移（分钟）
            initialPoints: 0, // 初始积分
            currentPoints: 0, // 当前积分
            gainedPoints: 0 // 已获得积分
        }
        this.logger = new Logger(this) // 初始化日志记录器
        this.accounts = [] // 初始化账户数组
        this.cookies = { mobile: [], desktop: [] } // 初始化cookies对象
        this.utils = new Utils() // 初始化工具类
        this.workers = new Workers(this) // 初始化工作进程管理器
        this.searchManager = new SearchManager(this) // 初始化搜索管理器
        this.browser = {
            func: new BrowserFunc(this), // 初始化浏览器功能
            utils: new BrowserUtils(this) // 初始化浏览器工具
        }
        this.config = loadConfig() // 加载配置
        this.activeWorkers = this.config.clusters // 设置活跃工作进程数
        this.exitedWorkers = [] // 初始化已退出工作进程数组
    }

    private buildSummaryMessage(accountStats: AccountStats[], runStartTime: number, hadWorkerFailure: boolean): string {
        const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
        const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
        const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
        const statusColor = hadWorkerFailure ? '#e74c3c' : '#27ae60'
        const statusText = hadWorkerFailure ? '异常' : '完成'
        const accentColor = '#667eea'

        const escapeHtml = (s: string): string =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

        let rows = ''
        for (const stat of accountStats) {
            const rowColor = stat.success ? '#27ae60' : '#e74c3c'
            const status = stat.success ? '成功' : '失败'
            const duration = Number.isFinite(stat.duration) ? stat.duration.toFixed(1) : String(stat.duration)
            const errorHint = stat.error
                ? `<br><span style="font-size:10px;color:#e74c3c">${escapeHtml(stat.error)}</span>`
                : ''
            rows += `
      <div style="display:flex;align-items:center;padding:7px 10px;border-radius:6px;margin-bottom:4px;background:#fafafa">
        <span style="flex:1;font-size:11px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(stat.email)}</span>
        <span style="color:${accentColor};font-weight:700;margin:0 6px;font-size:13px;min-width:36px;text-align:right">+${stat.collectedPoints}</span>
        <span style="font-size:10px;color:#bbb;margin:0 4px">${stat.initialPoints}&rarr;${stat.finalPoints}</span>
        <span style="color:${rowColor};font-size:11px;min-width:24px;text-align:center;font-weight:600">${status}</span>
      </div>${errorHint}`
        }

        return `
<div style="max-width:420px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:13px;color:#333">
  <div style="background:linear-gradient(135deg,${accentColor},#764ba2);color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">
    <div style="font-size:17px;font-weight:700;margin-bottom:2px">Microsoft Rewards</div>
    <div style="font-size:11px;opacity:0.8">${timestamp}</div>
  </div>
  <div style="background:#fff;padding:14px 16px;border:1px solid #e8e8e8;border-top:none;border-radius:0 0 8px 8px">
    <div style="display:flex;justify-content:space-between;margin-bottom:14px;text-align:center">
      <div style="flex:1">
        <div style="font-size:22px;font-weight:700;color:${accentColor}">+${totalCollectedPoints}</div>
        <div style="font-size:10px;color:#999;margin-top:2px">今日获取</div>
      </div>
      <div style="flex:1">
        <div style="font-size:18px;font-weight:600;color:#333">${totalFinalPoints}</div>
        <div style="font-size:10px;color:#999;margin-top:2px">当前积分</div>
      </div>
      <div style="flex:1">
        <span style="display:inline-block;background:${statusColor};color:#fff;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600">${statusText}</span>
        <div style="font-size:10px;color:#999;margin-top:4px">${totalDurationMinutes} 分钟</div>
      </div>
    </div>
    <div style="border-top:1px solid #f0f0f0;padding-top:10px">
      <div style="font-size:11px;color:#999;margin-bottom:6px">账户明细</div>
      ${rows}
    </div>
  </div>
</div>`
    }

    private async sendPushPlusSummary(
        accountStats: AccountStats[],
        runStartTime: number,
        hadWorkerFailure: boolean
    ): Promise<void> {
        const pushplus = this.config?.webhook?.pushplus
        if (!pushplus?.enabled || !pushplus.token) {
            return
        }

        const content = this.buildSummaryMessage(accountStats, runStartTime, hadWorkerFailure)
        await sendPushPlus(pushplus, content)
    }

    /**
     * Edge 浏览时长补足：在所有任务完成后，检查 Edge 浏览 30 分钟任务的进度，
     * 如果未完成则让浏览器保持打开 bing 页面，等待剩余时间。
     * 微软通过页面上的 JS 心跳追踪浏览时长，headless 浏览器中 JS 照常执行。
     */
    private async doEdgeBrowseCompensation(page: Page, accountEmail: string): Promise<void> {
        try {
            this.panelData = await this.browser.func.getPanelFlyoutData()
        } catch (error) {
            this.logger.warn(
                true,
                'EDGE-BROWSE',
                `获取 panelData 失败，跳过 Edge 浏览补足: ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        const attrs = this.panelData.flyoutResult?.dailyCheckInPromotion?.attributes
        if (!attrs) {
            this.logger.warn(true, 'EDGE-BROWSE', 'panelData 中未找到 dailyCheckInPromotion，跳过')
            return
        }

        if (attrs.partner_edge_completed === 'True') {
            this.logger.info(true, 'EDGE-BROWSE', 'Edge 浏览任务已完成，无需补足')
            return
        }

        const currentMinutes = parseInt(attrs.partner_edge_titleArg0 ?? '0', 10)
        const targetMinutes = parseInt(attrs.partner_edge_titleArg1 ?? '30', 10)
        const remainingMinutes = targetMinutes - currentMinutes

        if (remainingMinutes <= 0) {
            this.logger.info(true, 'EDGE-BROWSE', `Edge 浏览已达标 (${currentMinutes}/${targetMinutes})，无需补足`)
            return
        }

        this.logger.info(
            true,
            'EDGE-BROWSE',
            `Edge 浏览进度: ${currentMinutes}/${targetMinutes} 分钟 | 需补足: ${remainingMinutes} 分钟 | ${accountEmail}`
        )

        // 打开 bing 新闻页面（页面 JS 会向微软上报浏览心跳）
        try {
            await page.goto('https://www.bing.com/news', { waitUntil: 'domcontentloaded', timeout: 30000 })
        } catch {
            this.logger.warn(true, 'EDGE-BROWSE', '打开 bing 新闻页面失败，尝试 bing 首页')
            try {
                await page.goto('https://www.bing.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
            } catch {
                this.logger.error(true, 'EDGE-BROWSE', '无法打开浏览页面，放弃补足')
                return
            }
        }

        // 每 30 秒滚动一次页面，模拟真实浏览行为
        const intervalMs = 30_000
        const totalMs = remainingMinutes * 60_000
        const iterations = Math.ceil(totalMs / intervalMs)

        for (let i = 0; i < iterations; i++) {
            await this.utils.wait(intervalMs)

            // 随机滚动模拟阅读
            await page.evaluate(() => {
                window.scrollBy(0, 300 + Math.random() * 400)
            }).catch(() => {})

            // 每分钟输出一次进度
            if ((i + 1) % 2 === 0) {
                const elapsed = ((i + 1) * 30 / 60).toFixed(1)
                this.logger.info(
                    true,
                    'EDGE-BROWSE',
                    `浏览补足中... 已等待 ${elapsed} / ${remainingMinutes} 分钟`
                )
            }
        }

        this.logger.info(
            true,
            'EDGE-BROWSE',
            `Edge 浏览补足完成 | 额外浏览 ${remainingMinutes} 分钟 | ${accountEmail}`,
            'green'
        )
    }

    // 获取当前是否为移动端的上下文
    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    // 初始化账户数据
    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
    }

    // 运行主要的积分收集流程
    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        this.logger.info(
            'main',
            'RUN-START',
            `启动微软奖励脚本 | v${pkg.version} | 账户数: ${totalAccounts} | 集群数: ${this.config.clusters}`
        )

        // 如果集群数大于1，则使用多进程模式
        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                // 主进程逻辑
                await this.runMaster(runStartTime)
            } else {
                // 工作进程逻辑
                this.runWorker(runStartTime)
            }
        } else {
            // 单进程模式，直接运行任务
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runMaster(runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `主进程已启动 | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        for (const chunk of accountChunks) {
            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }
            })

            // Startup delay for clusters due to resource usage
            if (accountChunks.indexOf(chunk) !== accountChunks.length - 1) {
                await this.utils.wait(5000)
            }
        }

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            }

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            // exit 0 = good, exit 1 = crash
            const failed = (code ?? 0) !== 0 || Boolean(signal)
            if (failed) {
                hadWorkerFailure = true
            }

            this.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `工作进程 ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `已完成所有账户 | 已处理账户: ${allAccountStats.length} | 总收集积分: +${totalCollectedPoints} | 原始总计: ${totalInitialPoints} → 新总计: ${totalFinalPoints} | 总运行时间: ${totalDurationMinutes}分钟`,
                    'green'
                )

                await this.sendPushPlusSummary(allAccountStats, runStartTime, hadWorkerFailure)
                await flushAllWebhooks()

                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('exit', (worker, code, signal) => {
            void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
        })

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`) // <-- Warning only
        })
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `工作进程已生成 | PID: ${process.pid}`)
        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `工作进程 ${process.pid} 接收到 ${chunk.length} 个账户。`
            )

            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())

                // Send and flush before exit
                if (process.send) {
                    process.send({ __stats: stats })
                }

                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `工作进程任务崩溃: ${error instanceof Error ? error.message : String(error)}`
                )

                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const account of accounts) {
            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)
            this.userData.timezoneOffset = String(-new Date().getTimezoneOffset())

            try {
                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `开始处理账户: ${accountEmail} | 地理位置: ${account.geoLocale}`
                )

                this.axios = new AxiosClient(account.proxy)

                const result: { initialPoints: number; collectedPoints: number } | undefined = await this.Main(
                    account
                ).catch(error => {
                    void this.logger.error(
                        true,
                        'FLOW',
                        `${accountEmail} 的移动流程失败: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints

                    accountStats.push({
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        duration: parseFloat(durationSeconds),
                        success: true
                    })

                    this.logger.info(
                        'main',
                        'ACCOUNT-END',
                        `已完成账户: ${accountEmail} | 总计: +${collectedPoints} | 原始: ${accountInitialPoints} → 新值: ${accountFinalPoints} | 持续时间: ${durationSeconds}秒`,
                        'green'
                    )
                } else {
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: '流程失败'
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                })
            }
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `已完成所有账户 | 已处理账户: ${accountStats.length} | 总收集积分: +${totalCollectedPoints} | 原始总计: ${totalInitialPoints} → 新总计: ${totalFinalPoints} | 总运行时间: ${totalDurationMinutes}分钟`,
                'green'
            )

            const hadWorkerFailure = accountStats.some(s => !s.success)
            await this.sendPushPlusSummary(accountStats, runStartTime, hadWorkerFailure)
            await flushAllWebhooks()
            process.exit(0)
        }

        return accountStats
    }

    async Main(account: Account): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `开始为 ${accountEmail} 创建会话`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `移动浏览器已启动 | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error(
                        'main',
                        'FLOW',
                        `获取移动访问令牌失败: ${error instanceof Error ? error.message : String(error)}`
                    )
                }

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                const data: DashboardData = await this.browser.func.getDashboardData()
                const appData: AppDashboardData = await this.browser.func.getAppDashboardData()
                this.panelData = await this.browser.func.getPanelFlyoutData()

                // 新版 UI 用 Next.js Server Actions，提取部署 ID 用于请求头和日志对照。
                // 版本号本身不再拦截调用（hash 通常不随部署变更）；仅提取不到 ID 时才跳过。
                this.serverActions.deploymentId = await this.browser.func.extractDeploymentId(this.mainMobilePage)
                if (this.serverActions.deploymentId) {
                    this.logger.info(
                        'main',
                        'SERVER-ACTION',
                        `新版仪表板部署 ID: ${this.serverActions.deploymentId} | hash 抓录版本(参考): ${BrowserFunc.SUPPORTED_DEPLOYMENT_ID}`
                    )
                }
                // 设置地理位置
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? data.userProfile.attributes.country : account.geoLocale.toLowerCase()
                if (this.userData.geoLocale.length > 2) {
                    this.logger.warn(
                        'main',
                        'GEO-LOCALE',
                        `提供的地理位置长度超过2位 (${this.userData.geoLocale} | 自动=${account.geoLocale === 'auto'})，这可能是无效的并导致错误！`
                    )
                }

                this.userData.initialPoints = data.userStatus.availablePoints
                this.userData.currentPoints = data.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                const appEarnable = await this.browser.func.getAppEarnablePoints()

                this.pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `今日可赚取 | 移动端: ${this.pointsCanCollect} | 浏览器: ${
                        browserEarnable.mobileSearchPoints
                    } | 应用: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | 区域设置: ${this.userData.geoLocale}`
                )

                // Ensure streak protection is true if enabled
                if (this.config.ensureStreakProtection) {
                    await this.activities.doStreakProtection()
                }
                if (this.config.workers.doClaimBonusPoints) await this.workers.doClaimBonusPoints(data)
                if (this.config.workers.doAppPromotions) await this.workers.doAppPromotions(appData)
                if (this.config.workers.doDailySet) await this.workers.doDailySet(data, this.mainMobilePage)
                if (this.config.workers.doSpecialPromotions) await this.workers.doSpecialPromotions(data)
                if (this.config.workers.doMorePromotions) await this.workers.doMorePromotions(data, this.mainMobilePage)
                if (this.config.workers.doDailyCheckIn) await this.activities.doDailyCheckIn()
                if (this.config.workers.doReadToEarn) await this.activities.doReadToEarn()
                if (this.config.workers.doPunchCards) await this.workers.doPunchCards(data, this.mainMobilePage)

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                this.cookies.mobile = await initialContext.cookies()

                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                    data,
                    missingSearchPoints,
                    mobileSession,
                    account,
                    accountEmail
                )

                // Edge 浏览时长补足：检查进度，不足则继续浏览
                await this.doEdgeBrowseCompensation(this.mainMobilePage, accountEmail)

                mobileContextClosed = true

                this.userData.gainedPoints = mobilePoints + desktopPoints

                const finalPoints = await this.browser.func.getCurrentPoints()
                const collectedPoints = finalPoints - initialPoints

                this.logger.info(
                    'main',
                    'FLOW',
                    `已收集: +${collectedPoints} | 移动端: +${mobilePoints} | 桌面端: +${desktopPoints} | ${accountEmail}`
                )

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0
                }
            })
        } finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                    })
                } catch {}
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    // 在执行任何操作之前进行检查
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', '收到 SIGINT 信号，正在刷新并退出...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', '收到 SIGTERM 信号，正在刷新并退出...')
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})
