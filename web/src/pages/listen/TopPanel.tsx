import { useEffect, useState } from 'react'
import { Typography } from 'antd'
import { channelLabel } from '@core'
import type { Conversation } from '../../api'
import { PlayAll } from '../../components/PlayAll'
import { agoText } from './model'
import { LiveStrip } from './LiveStrip'

/** 此刻的 Unix 秒，每分钟追一次。渲染过程本身不直接调 Date.now()。 */
function useNowS(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60000)
    return () => clearInterval(t)
  }, [])
  return now
}

/**
 * 收听页顶上那一块：最新一次对话（callsign 或呼号未知、信道、多久以前、
 * PlayAll）加实时条。固定高度，不随数据涨缩——15 秒一刷，按钮随数据出现
 * 或消失的话，手指落下去的那一刻底下已经换了一行。
 *
 * newest 是「当前列表已经加载到的行里最新的那条」，不是另外拉一次。
 * 待确认和未入库两档只有实时条：那两档本来就没有「今天听到了什么」这层意义。
 */
export function TopPanel({
  newest,
  showNewest,
}: {
  newest?: Conversation
  showNewest: boolean
}) {
  const nowS = useNowS()
  return (
    <div className="listen-panel">
      {showNewest && (
        <div className="listen-panel-row">
          <span className="listen-panel-call callsign">
            {newest ? (newest.qso?.call ?? newest.draft?.call ?? '呼号未知') : '还没听到过'}
          </span>
          {newest && <span className="listen-panel-channel">{channelLabel(newest.channel)}</span>}
          {newest && (
            <Typography.Text type="secondary" className="listen-panel-ago">
              {agoText(nowS, newest.startAt)}
            </Typography.Text>
          )}
          <div className="listen-panel-play">
            <PlayAll activities={newest?.activities ?? []} />
          </div>
        </div>
      )}
      <LiveStrip />
    </div>
  )
}
