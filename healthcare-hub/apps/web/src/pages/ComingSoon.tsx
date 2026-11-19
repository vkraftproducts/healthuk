import { Card, Typography } from 'antd';

export function ComingSoon({ title, milestone }: { title: string; milestone: string }) {
  return (
    <Card size="small">
      <Typography.Title level={2} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        This module is built in Milestone {milestone}.
      </Typography.Paragraph>
    </Card>
  );
}