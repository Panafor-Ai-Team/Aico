import { Avatar, Flexbox, SortableList } from '@lobehub/ui';
import { memo } from 'react';

import { BrandedProviderIcon } from '@/components/Branding/BrandedProviderIcon';
import { type AiProviderListItem } from '@/types/aiProvider';

interface GroupItemProps extends AiProviderListItem {
  disabled?: boolean;
}

const GroupItem = memo<GroupItemProps>(({ id, name, source, logo, disabled }) => {
  return (
    <>
      <Flexbox horizontal gap={8}>
        {source === 'custom' && logo ? (
          <Avatar
            alt={name || id}
            avatar={logo}
            shape={'square'}
            size={24}
            style={{ borderRadius: 6 }}
          />
        ) : (
          <BrandedProviderIcon
            provider={id}
            size={24}
            style={{ borderRadius: 6 }}
            type={'avatar'}
          />
        )}
        {name}
      </Flexbox>
      {!disabled && <SortableList.DragHandle />}
    </>
  );
});

export default GroupItem;
