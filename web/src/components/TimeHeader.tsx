import { Fragment } from 'react'
import { useTime } from '../useTime'

/**
 * 表头里的「时间」。时区名放在第二行小字里：IANA 时区带偏移有二十多个字符，
 * 和「时间」写在一行里，184 或 190 宽的列放不下，被隔壁表头盖掉半个字。
 * 第二行装不下时换行（斜杠和空格处），不截断：偏移在最后，截掉的正是它。
 * 完整的也在悬停提示里。
 */
export function TimeHeader() {
  const { label } = useTime()
  return (
    <span className="time-header" title={`时间 ${label}`}>
      <span>时间</span>
      <span className="time-header-zone">
        {label.split('/').map((part, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <>
                /<wbr />
              </>
            )}
            {part}
          </Fragment>
        ))}
      </span>
    </span>
  )
}
