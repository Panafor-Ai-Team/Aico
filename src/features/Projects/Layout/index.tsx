'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import { Outlet } from 'react-router';

import ProjectDisabled from '@/features/Projects/ProjectDisabled';

import { useProjectsEnabled } from '../useProjectsEnabled';
import ProjectSidebar from './Sidebar';

const ProjectLayout = memo(() => {
  const enabled = useProjectsEnabled();

  if (!enabled) return <ProjectDisabled />;

  return (
    <>
      <ProjectSidebar />
      <Flexbox flex={1} height="100%" style={{ minWidth: 0 }}>
        <Outlet />
      </Flexbox>
    </>
  );
});

ProjectLayout.displayName = 'ProjectLayout';

export default ProjectLayout;
