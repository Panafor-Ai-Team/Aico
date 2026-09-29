'use client';

import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router';

import { ProductLogo } from '@/components/Branding';

const styles = createStaticStyles(({ css, cssVar }) => ({
  actions: css`
    margin-block-start: 12px;
  `,
  check: css`
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
  `,
  content: css`
    position: relative;
    z-index: 1;

    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;

    max-width: 420px;
  `,
  desc: css`
    margin: 0;
    font-size: 14px;
    line-height: 1.7;
    color: ${cssVar.colorTextSecondary};
  `,
  root: css`
    position: relative;

    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    width: 100%;
    min-height: 100%;
    padding-block: 48px;
    padding-inline: 24px;

    text-align: center;
  `,
  status: css`
    pointer-events: none;
    user-select: none;

    position: absolute;
    z-index: 0;

    margin: 0;

    font-size: min(180px, 40vw);
    font-weight: 700;
    line-height: 1;
    color: ${cssVar.colorText};

    opacity: 0.06;
  `,
  title: css`
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
}));

const RouterHomeButton = memo<{ label: string }>(({ label }) => {
  const navigate = useNavigate();

  return (
    <Button type={'primary'} onClick={() => navigate('/')}>
      {label}
    </Button>
  );
});

RouterHomeButton.displayName = 'RouterHomeButton';

const HomeButton = memo<{ label: string }>(({ label }) => {
  const inRouter = useInRouterContext();

  if (inRouter) return <RouterHomeButton label={label} />;

  return (
    <Button type={'primary'} onClick={() => (window.location.href = '/')}>
      {label}
    </Button>
  );
});

HomeButton.displayName = 'HomeButton';

const NotFound = memo<{
  desc?: string;
  extra?: ReactNode;
  hideWatermark?: boolean;
  status?: number | string;
  title?: string;
}>(({ extra, hideWatermark, status = 404, title, desc }) => {
  const { t } = useTranslation('error');

  return (
    <div className={styles.root}>
      {!hideWatermark && status !== '' && <h1 className={styles.status}>{status}</h1>}
      <div className={styles.content}>
        <ProductLogo size={40} type={'flat'} />
        <h2 className={styles.title}>{title || t('notFound.title')}</h2>
        <Flexbox align={'center'} gap={4}>
          <p className={styles.desc}>{desc || t('notFound.desc')}</p>
          {!desc && <p className={styles.check}>{t('notFound.check')}</p>}
        </Flexbox>
        <div className={styles.actions}>
          {extra || <HomeButton label={t('notFound.backHome')} />}
        </div>
      </div>
    </div>
  );
});

NotFound.displayName = 'NotFound';

export default NotFound;
