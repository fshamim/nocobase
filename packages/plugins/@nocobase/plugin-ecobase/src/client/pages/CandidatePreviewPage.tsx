/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Alert, Card, Typography } from 'antd';
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { CandidatePreviewLoader } from '../../features/inventory-planning/client/CandidatePreviewLoader';
import { useT } from '../locale';

export default function CandidatePreviewPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get('runId')?.trim() ?? '';

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={3}>{t('Verified unpublished candidate preview')}</Typography.Title>
      {!runId ? (
        <Alert
          role="alert"
          type="error"
          showIcon
          message={t('Candidate preview requires an explicit verified run ID.')}
        />
      ) : (
        <Card title={t('Read-only candidate evidence')}>
          <CandidatePreviewLoader initialRunId={runId} autoLoad readOnly />
        </Card>
      )}
    </div>
  );
}
