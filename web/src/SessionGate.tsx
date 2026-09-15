import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { LockOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Form, Input, Spin, Typography } from 'antd'
import { ApiError, api } from './api'
import { SessionContext } from './session'

/**
 * 管理端整个挡在口令后面。
 *
 * 监听地址可以配到局域网，因为站在楼下拿手台时要用手机确认通联，
 * 那时回环地址是够不着的。公开页和健康检查不在这道门里面。
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState<boolean | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    api.session().then(
      (r) => setSignedIn(r.signedIn),
      () => setSignedIn(false),
    )
  }, [])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined)
    setSignedIn(false)
  }, [])

  const value = useMemo(() => ({ signedIn: signedIn === true, signOut }), [signedIn, signOut])

  if (signedIn === undefined) {
    return (
      <div className="gate">
        <Spin size="large" />
      </div>
    )
  }

  if (!signedIn) {
    const submit = async ({ password }: { password: string }) => {
      setBusy(true)
      try {
        await api.login(password)
        setError(undefined)
        setSignedIn(true)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className="gate">
        <Card className="gate-card">
          <Typography.Title level={3} style={{ marginTop: 0 }}>
            OpenHeard
          </Typography.Title>
          <Typography.Paragraph type="secondary">
            管理端要口令。公开展示页不在这道门里面。
          </Typography.Paragraph>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
          <Form layout="vertical" onFinish={submit}>
            <Form.Item name="password" rules={[{ required: true, message: '口令必填' }]}>
              <Input.Password autoFocus size="large" prefix={<LockOutlined />} placeholder="口令" />
            </Form.Item>
            <Button type="primary" size="large" block htmlType="submit" loading={busy}>
              进去
            </Button>
          </Form>
        </Card>
      </div>
    )
  }

  return <SessionContext value={value}>{children}</SessionContext>
}
