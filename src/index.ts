import { Context, Schema } from 'koishi'
import axios from 'axios'

interface TimeSetting {
  noticeBefore: number // 提前通知的分钟数
}

interface NotificationSetting {
  targetGroups: string[] // 目标群组列表
  scheduleTimes: string[] // 手动配置的多个检测时间
  timeSettings: TimeSetting[] // 多个提醒时间配置
}

interface Config {
  notifications: NotificationSetting[]
  enableLog: boolean // 是否启用详细日志
}

const TimeSettingSchema: Schema<TimeSetting> = Schema.object({
  noticeBefore: Schema.number()
    .description('提前通知时间（分钟）')
    .default(60)
    .min(1),
})

const NotificationSettingSchema: Schema<NotificationSetting> = Schema.object({
  targetGroups: Schema.array(Schema.string())
    .description('需要通知的群组ID列表')
    .default([]),
  scheduleTimes: Schema.array(Schema.string()
    .pattern(/^([01]\d|2[0-3]):([0-5]\d)$/)
    .description('检测时间（北京时间，格式: HH:MM）'))
    .description('手动配置多个检测时间，如 08:00, 12:00, 16:00')
    .default(['08:00', '12:00', '16:00']),
  timeSettings: Schema.array(TimeSettingSchema)
    .description('多个提前通知时间设置')
    .default([{ noticeBefore: 60 }]),
})

export const Config: Schema<Config> = Schema.object({
  notifications: Schema.array(NotificationSettingSchema)
    .description('通知配置列表')
    .default([]),
  enableLog: Schema.boolean()
    .description('是否启用详细日志输出')
    .default(true),
})

export const name = 'xfly-activity'

export function apply(ctx: Context, config: Config) {
  // 创建定时任务管理器
  const timerManager = new Map<string, NodeJS.Timeout>()

  // 日志输出函数
  function logInfo(message: string, ...args: any[]) {
    if (config.enableLog) {
      ctx.logger.info(`[活动插件] ${message}`, ...args)
    }
  }

  function logError(message: string, ...args: any[]) {
    ctx.logger.error(`[活动插件] ${message}`, ...args)
  }

  function logWarn(message: string, ...args: any[]) {
    ctx.logger.warn(`[活动插件] ${message}`, ...args)
  }

  function logDebug(message: string, ...args: any[]) {
    if (config.enableLog) {
      ctx.logger.debug(`[活动插件] ${message}`, ...args)
    }
  }

  // 获取合适的机器人实例（排除邮件适配器等）
  function getSuitableBot() {
    // 优先选择 onebot 适配器
    const onebotBot = ctx.bots.find(bot => bot.platform === 'onebot')
    if (onebotBot) {
      logDebug('使用 OneBot 适配器发送消息')
      return onebotBot
    }
    
    // 如果没有 onebot，选择第一个非邮件适配器的机器人
    const nonMailBot = ctx.bots.find(bot => !bot.ctx.provide?.name.includes('mail'))
    if (nonMailBot) {
      logDebug(`使用 ${nonMailBot.platform} 适配器发送消息`)
      return nonMailBot
    }
    
    // 如果只有邮件适配器，返回第一个
    if (ctx.bots.length > 0) {
      logWarn('只能使用邮件适配器发送消息，这可能不会成功')
      return ctx.bots[0]
    }
    
    return null
  }

  // 北京时间日期处理函数
  function getBeijingDate(timestamp?: number) {
    const date = timestamp ? new Date(timestamp) : new Date()
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
  }

  // 获取当日北京时间零点
  function getTodayStart() {
    const beijingDate = getBeijingDate()
    beijingDate.setHours(0, 0, 0, 0)
    return beijingDate.getTime()
  }

  // 格式化时间显示
  function formatTime(timestamp: number): string {
    return getBeijingDate(timestamp).toLocaleString('zh-CN')
  }

  // 计算距离下一个指定时间点的毫秒数
  function getNextScheduleDelay(targetTime: string): number {
    const [hour, minute] = targetTime.split(':').map(Number)
    const now = getBeijingDate()
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute)
    
    let delay = target.getTime() - now.getTime()
    
    // 如果目标时间已经过去，设置为明天的同一时间
    if (delay < 0) {
      delay += 86400000 // 24小时
    }
    
    return delay
  }

  // 验证时间格式并排序
  function validateAndSortTimes(times: string[]): string[] {
    const validTimes = times.filter(time => /^([01]\d|2[0-3]):([0-5]\d)$/.test(time))
    
    // 按时间排序
    return validTimes.sort((a, b) => {
      const [aHour, aMinute] = a.split(':').map(Number)
      const [bHour, bMinute] = b.split(':').map(Number)
      
      if (aHour !== bHour) return aHour - bHour
      return aMinute - bMinute
    })
  }

  // 从API获取活动数据的函数
  async function fetchActivities() {
    try {
      logInfo('正在从API获取活动数据...')
      const res = await axios.get('https://api.xflysim.com/pilot/api/panel/activity?count=20')
      
      if (res.data.code !== 20000) {
        throw new Error(`API返回错误: ${res.data.message}`)
      }
      
      return res.data.data
    } catch (error) {
      logError('获取活动数据时发生错误:', error)
      throw error
    }
  }

  // 获取当天活动
  async function getTodayActivities() {
    try {
      const activities = await fetchActivities()
      const todayStart = getTodayStart()
      const todayEnd = todayStart + 86400000 // 24小时后

      // 筛选当日活动
      const todayActivities = activities.filter((act: any) => {
        return act.time >= todayStart && act.time < todayEnd
      })

      return todayActivities
    } catch (error) {
      logError('获取当天活动时发生错误:', error)
      throw error
    }
  }

  // 计算距离活动开始的分钟数
  function calculateMinutesUntilStart(activityTime: number): number {
    const now = Date.now()
    const timeUntilStart = activityTime - now
    return Math.max(0, Math.floor(timeUntilStart / 60000))
  }

  // 格式化活动信息用于输出（与通知相同的格式）
  function formatActivityForOutput(activity: any, isQuery: boolean = false): string {
    const startDate = getBeijingDate(activity.time)
    const timeStr = startDate.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    const dateStr = startDate.toLocaleDateString('zh-CN').replace(/\//g, '-')
    
    const minutesUntilStart = calculateMinutesUntilStart(activity.time)

    // 使用与通知相同的格式
    let message = ''
    
    if (isQuery) {
      // 查询模式下添加@全体成员和剩余时间提示
      message = `@全体成员 活动还有 ${minutesUntilStart} 分钟就要开始啦!\n`
    }
    
    message += `【${activity.name}】\n`
    message += `活动开始时间: ${timeStr}\n`
    message += `日期: ${dateStr}\n\n`
    message += `【航线】 ${activity.departure} ${activity.arrival}\n`
    message += `【飞行规则】${activity.rule}\n`
    message += `【飞行距离】${activity.distance} 海里\n`
    message += `【飞行方向】${activity.direction}\n`
    message += `【导航版本】${activity.cycle}\n`
    message += `【飞行航路】${activity.route}\n`
    message += `【机场等级】${activity.airportLevel}\n`
    
    if (activity.remark && activity.remark !== '无') {
      message += `\n【注意事项】${activity.remark}\n`
    }
    
    message += `\n【发布者】${activity.cid}\n\n`
    message += `飞行情报详情查看： https://www.xflysim.com/main/activity/${activity.aid}\n`
    message += 'XFlysim 祝各位飞行员飞行愉快!'
    
    return message
  }

  // 主检测函数
  async function checkActivities(setting: NotificationSetting, scheduleTime?: string) {
    const timeLabel = scheduleTime ? `在 ${scheduleTime}` : '手动'
    logInfo(`开始${timeLabel}检测活动，目标群组: ${setting.targetGroups.join(', ')}`)
    
    try {
      // 清理旧临时定时器（只清理活动相关的临时定时器）
      const tempTimers = Array.from(timerManager.entries()).filter(([key]) => key.startsWith('temp-'))
      tempTimers.forEach(([key, timer]) => {
        clearTimeout(timer)
        timerManager.delete(key)
        logDebug(`清理临时定时器: ${key}`)
      })

      const activities = await fetchActivities()

      const now = Date.now()
      const todayStart = getTodayStart()
      const todayEnd = todayStart + 86400000 // 24小时后

      logInfo(`时间范围: ${formatTime(todayStart)} - ${formatTime(todayEnd)}`)

      // 筛选当日活动
      const todayActivities = activities.filter((act: any) => {
        return act.time >= todayStart && act.time < todayEnd
      })

      logInfo(`API返回 ${activities.length} 个活动，其中 ${todayActivities.length} 个是今日活动`)

      if (todayActivities.length === 0) {
        logInfo('今日没有活动')
        return
      }

      // 记录活动详情
      todayActivities.forEach((act: any) => {
        logDebug(`活动 ${act.aid}: ${act.name} - ${formatTime(act.time)}`)
      })

      let timerCount = 0
      // 处理每个活动
      todayActivities.forEach((activity: any) => {
        setting.timeSettings.forEach(({ noticeBefore }) => {
          const notifyTime = activity.time - noticeBefore * 60000
          
          // 仅处理未来的通知
          if (notifyTime > now) {
            const timerKey = `act-${activity.aid}-${noticeBefore}`
            
            // 避免重复设置
            if (!timerManager.has(timerKey)) {
              const timeout = notifyTime - now
              const timer = setTimeout(() => sendNotification(activity, noticeBefore, setting), timeout)
              timerManager.set(timerKey, timer)
              timerCount++
              logInfo(`设置定时通知: 活动 ${activity.name} (${activity.aid}) 将在 ${noticeBefore} 分钟前通知，距离现在 ${Math.round(timeout/60000)} 分钟`)
            } else {
              logDebug(`定时器已存在，跳过: ${timerKey}`)
            }
          } else {
            logDebug(`通知时间已过，跳过: 活动 ${activity.aid} 的 ${noticeBefore} 分钟前通知`)
          }
        })
      })

      logInfo(`成功设置了 ${timerCount} 个定时通知`)
      
      // 记录当前所有活跃的定时器
      logDebug(`当前活跃定时器数量: ${timerManager.size}`)
      timerManager.forEach((_, key) => {
        logDebug(`活跃定时器: ${key}`)
      })

    } catch (error) {
      logError('检测活动时发生错误:', error)
    }
  }

  // 发送通知函数
  async function sendNotification(activity: any, noticeBefore: number, setting: NotificationSetting) {
    const timerKey = `act-${activity.aid}-${noticeBefore}`
    
    // 立即清理定时器
    if (timerManager.has(timerKey)) {
      clearTimeout(timerManager.get(timerKey))
      timerManager.delete(timerKey)
      logDebug(`发送通知后清理定时器: ${timerKey}`)
    }

    const startDate = getBeijingDate(activity.time)
    const timeStr = startDate.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    const dateStr = startDate.toLocaleDateString('zh-CN').replace(/\//g, '-')

    logInfo(`准备发送活动通知: ${activity.name} (${activity.aid})，提前 ${noticeBefore} 分钟`)

    // 直接构造消息字符串
    let message = `@全体成员 活动还有 ${noticeBefore} 分钟就要开始啦!\n`
    message += `【${activity.name}】\n`
    message += `活动开始时间: ${timeStr}\n`
    message += `日期: ${dateStr}\n\n`
    message += `【航线】 ${activity.departure} ${activity.arrival}\n`
    message += `【飞行规则】${activity.rule}\n`
    message += `【飞行距离】${activity.distance} 海里\n`
    message += `【飞行方向】${activity.direction}\n`
    message += `【导航版本】${activity.cycle}\n`
    message += `【飞行航路】${activity.route}\n`
    message += `【机场等级】${activity.airportLevel}\n`
    
    if (activity.remark && activity.remark !== '无') {
      message += `\n【注意事项】${activity.remark}\n`
    }
    
    message += `\n【发布者】${activity.cid}\n\n`
    message += `飞行情报详情查看： https://www.xflysim.com/main/activity/${activity.aid}\n`
    message += 'XFlysim 祝各位飞行员飞行愉快!'

    // 发送到所有目标群组
    let successCount = 0
    let failCount = 0
    
    const bot = getSuitableBot()
    if (!bot) {
      logError('没有找到可用的机器人实例来发送消息')
      return
    }
    
    for (const groupId of setting.targetGroups) {
      try {
        // 使用选定的机器人发送消息
        await bot.sendMessage(groupId, message)
        successCount++
        logInfo(`成功发送活动 ${activity.aid} 通知到群组 ${groupId}`)
      } catch (error) {
        failCount++
        logError(`发送活动 ${activity.aid} 通知到群组 ${groupId} 失败:`, error)
      }
    }

    logInfo(`通知发送完成: 成功 ${successCount} 个群组，失败 ${failCount} 个群组`)
  }

  // 为单个检测时间设置定时任务
  function setupScheduleTimer(setting: NotificationSetting, configIndex: number, scheduleTime: string, scheduleIndex: number) {
    const delay = getNextScheduleDelay(scheduleTime)
    const timerKey = `schedule-${configIndex}-${scheduleIndex}`

    logInfo(`配置 ${configIndex + 1} 的检测时间 ${scheduleTime}: 将在 ${Math.round(delay/60000)} 分钟后执行首次检测`)

    // 创建检测任务
    const timer = setTimeout(() => {
      logInfo(`执行配置 ${configIndex + 1} 在 ${scheduleTime} 的首次活动检测`)
      checkActivities(setting, scheduleTime)

      // 设置每日重复
      const dailyTimer = setInterval(() => {
        logInfo(`执行配置 ${configIndex + 1} 在 ${scheduleTime} 的定时活动检测`)
        checkActivities(setting, scheduleTime)
      }, 86400000) // 24小时

      timerManager.set(`daily-${configIndex}-${scheduleIndex}`, dailyTimer as any)
      logInfo(`已设置配置 ${configIndex + 1} 在 ${scheduleTime} 的每日定时检测`)

    }, delay)

    timerManager.set(timerKey, timer)
  }

  // 初始化定时任务
  function initializeSchedules() {
    logInfo(`开始初始化 ${config.notifications.length} 个通知配置的定时任务`)
    
    config.notifications.forEach((setting, configIndex) => {
      // 验证和排序检测时间
      const validTimes = validateAndSortTimes(setting.scheduleTimes)
      
      if (validTimes.length === 0) {
        logWarn(`配置 ${configIndex + 1}: 没有有效的检测时间，跳过初始化`)
        return
      }
      
      if (validTimes.length !== setting.scheduleTimes.length) {
        logWarn(`配置 ${configIndex + 1}: 部分检测时间格式无效，已过滤`)
      }
      
      logInfo(`配置 ${configIndex + 1}: 共有 ${validTimes.length} 个检测时间: ${validTimes.join(', ')}`)
      
      // 为每个检测时间设置定时任务
      validTimes.forEach((scheduleTime, scheduleIndex) => {
        setupScheduleTimer(setting, configIndex, scheduleTime, scheduleIndex)
      })
    })

    logInfo(`定时任务初始化完成，共设置 ${timerManager.size} 个定时器`)
  }

  // 立即执行一次检测（可选功能）
  async function forceCheck() {
    logInfo('开始手动强制检测所有配置')
    for (const [index, setting] of config.notifications.entries()) {
      await checkActivities(setting, `手动检测-配置${index + 1}`)
    }
  }

  // 强制查询当天活动函数
  async function forceTodayActivityQuery(): Promise<string> {
    try {
      logInfo('执行强制当天活动查询')
      const todayActivities = await getTodayActivities()
      
      if (todayActivities.length === 0) {
        return '今日无活动'
      }
      
      // 按时间排序（从早到晚）
      const sortedActivities = todayActivities.sort((a: any, b: any) => a.time - b.time)
      
      let result = ''
      
      // 限制输出数量，避免消息过长
      const maxOutput = 5
      const activitiesToShow = sortedActivities.slice(0, maxOutput)
      
      activitiesToShow.forEach((activity: any, index: number) => {
        // 使用查询模式格式化活动信息
        result += formatActivityForOutput(activity, true)
        if (index < activitiesToShow.length - 1) {
          result += '\n\n' + '='.repeat(40) + '\n\n'
        }
      })
      
      if (sortedActivities.length > maxOutput) {
        result += `\n... 还有 ${sortedActivities.length - maxOutput} 个活动未显示`
      }
      
      return result
    } catch (error) {
      logError('强制当天活动查询失败:', error)
      return `查询失败: ${error.message}`
    }
  }

  // 注册强制检测命令
  ctx.command('活动检测', '手动触发活动检测')
    .action(async ({ session }) => {
      logInfo(`用户 ${session.userId} 触发手动检测`)
      await forceCheck()
      return '活动检测已完成'
    })

  // 注册强制当天活动查询命令 - 仅限指定用户使用
  ctx.command('今日活动', '强制查询今日所有活动')
    .action(async ({ session }) => {
      const allowedUserId = '168329908'
      
      if (session.userId !== allowedUserId) {
        logWarn(`用户 ${session.userId} 尝试使用今日活动查询命令，但无权限`)
        return '抱歉，您没有权限使用此命令'
      }
      
      logInfo(`用户 ${session.userId} 执行今日活动查询`)
      const result = await forceTodayActivityQuery()
      return result
    })

  // 注册查看定时器状态命令
  ctx.command('活动定时器状态', '查看当前活动定时器状态')
    .action(async ({ session }) => {
      const timerInfo = Array.from(timerManager.entries()).map(([key]) => key).join('\n')
      logInfo(`用户 ${session.userId} 查看定时器状态，当前有 ${timerManager.size} 个定时器`)
      return `当前活跃定时器 (${timerManager.size} 个):\n${timerInfo || '无'}`
    })

  // 注册查看配置信息命令
  ctx.command('活动配置信息', '查看当前活动插件配置信息')
    .action(async ({ session }) => {
      const configInfo = config.notifications.map((setting, index) => {
        return `配置 ${index + 1}:
  - 目标群组: ${setting.targetGroups.join(', ') || '无'}
  - 检测时间: ${setting.scheduleTimes.join(', ')}
  - 提前通知: ${setting.timeSettings.map(ts => `${ts.noticeBefore}分钟`).join(', ')}`
      }).join('\n\n')
      
      logInfo(`用户 ${session.userId} 查看配置信息`)
      return `当前活动插件配置:\n\n${configInfo}`
    })

  // 注册重新加载定时器命令
  ctx.command('重载活动定时器', '重新加载活动检测定时器')
    .action(async ({ session }) => {
      logInfo(`用户 ${session.userId} 触发重载定时器`)
      
      // 清理所有定时器
      timerManager.forEach((timer, key) => {
        if (key.startsWith('act-')) {
          clearTimeout(timer)
        } else {
          clearInterval(timer)
        }
      })
      timerManager.clear()
      
      // 重新初始化
      initializeSchedules()
      
      return '活动定时器已重新加载'
    })

  // 启动时初始化
  ctx.on('ready', () => {
    logInfo('插件启动，开始初始化定时任务')
    initializeSchedules()
    
    // 启动后延迟5秒执行一次检测，确保系统稳定
    setTimeout(() => {
      logInfo('执行启动后首次检测')
      forceCheck().catch(error => {
        logError('启动后首次检测失败:', error)
      })
    }, 5000)
  })

  // 插件卸载时清理定时器
  ctx.on('dispose', () => {
    logInfo('插件卸载，开始清理定时器')
    let clearedCount = 0
    timerManager.forEach((timer, key) => {
      if (key.startsWith('act-')) {
        clearTimeout(timer)
      } else {
        clearInterval(timer)
      }
      clearedCount++
      logDebug(`清理定时器: ${key}`)
    })
    timerManager.clear()
    logInfo(`插件卸载完成，共清理 ${clearedCount} 个定时器`)
  })

  logInfo('活动提醒插件加载完成')
}