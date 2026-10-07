import transformImports from '@rolldown/plugin-transform-imports';
import type { PluginOption } from 'vite';

/**
 * Rewrites the @lobehub/ui barrel to deep imports.
 *
 * The barrel (es/index.mjs) statically re-exports 200+ components -
 * including Markdown (remark/rehype pipeline), Mermaid, EmojiPicker
 * (emoji-mart dataset), HtmlPreview, and the icon catalog. Any barrel import
 * in the eager provider chain (SPAGlobalProvider > ThemeProvider >
 * Markdown) promotes the whole barrel into the entry chunk (~4 MB raw).
 * Deep imports keep each route's UI dependencies in its own lazy chunk.
 *
 * Member > path map generated from node_modules/@lobehub/ui/es/index.mjs
 * (v5.24.0). Regenerate when upgrading @lobehub/ui.
 */
const defaultMembers: Array<[string, string]> = [
  ['A', '@lobehub/ui/es/A/index'],
  ['Accordion', '@lobehub/ui/es/Accordion/Accordion'],
  ['AccordionItem', '@lobehub/ui/es/Accordion/AccordionItem'],
  ['ActionIcon', '@lobehub/ui/es/ActionIcon/ActionIcon'],
  ['ActionIconGroup', '@lobehub/ui/es/ActionIconGroup/ActionIconGroup'],
  ['Alert', '@lobehub/ui/es/Alert/Alert'],
  ['AutoComplete', '@lobehub/ui/es/AutoComplete/Select'],
  ['Avatar', '@lobehub/ui/es/Avatar/index'],
  ['AvatarGroup', '@lobehub/ui/es/Avatar/AvatarGroup/index'],
  ['Block', '@lobehub/ui/es/Block/Block'],
  ['Burger', '@lobehub/ui/es/Burger/Burger'],
  ['Button', '@lobehub/ui/es/Button/Button'],
  ['Center', '@lobehub/ui/es/Flex/Center'],
  ['Checkbox', '@lobehub/ui/es/Checkbox/index'],
  ['CheckboxGroup', '@lobehub/ui/es/Checkbox/CheckboxGroup'],
  ['CodeEditor', '@lobehub/ui/es/CodeEditor/CodeEditor'],
  ['Collapse', '@lobehub/ui/es/Collapse/Collapse'],
  ['ColorSwatches', '@lobehub/ui/es/ColorSwatches/ColorSwatches'],
  ['ConfigProvider', '@lobehub/ui/es/ConfigProvider/index'],
  ['CopyButton', '@lobehub/ui/es/CopyButton/CopyButton'],
  ['DatePicker', '@lobehub/ui/es/DatePicker/DatePicker'],
  ['DownloadButton', '@lobehub/ui/es/DownloadButton/DownloadButton'],
  ['DraggablePanel', '@lobehub/ui/es/DraggablePanel/index'],
  ['DraggablePanelBody', '@lobehub/ui/es/DraggablePanel/components/DraggablePanelBody'],
  ['DraggablePanelContainer', '@lobehub/ui/es/DraggablePanel/components/DraggablePanelContainer'],
  ['DraggablePanelFooter', '@lobehub/ui/es/DraggablePanel/components/DraggablePanelFooter'],
  ['DraggablePanelHeader', '@lobehub/ui/es/DraggablePanel/components/DraggablePanelHeader'],
  ['DraggableSideNav', '@lobehub/ui/es/DraggableSideNav/DraggableSideNav'],
  ['Drawer', '@lobehub/ui/es/Drawer/Drawer'],
  ['Dropdown', '@lobehub/ui/es/Dropdown/Dropdown'],
  ['DropdownMenu', '@lobehub/ui/es/base-ui/DropdownMenu/DropdownMenu'],
  ['DropdownMenuCheckboxItemPrimitive', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuFooter', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuGroup', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuGroupLabel', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuHeader', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuItem', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuItemContent', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuItemExtra', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuItemIcon', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuItemLabel', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuPopup', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuPortal', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuPositioner', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuRoot', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuScrollViewport', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuSeparator', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuSubmenuArrow', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuSubmenuRoot', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['DropdownMenuSubmenuTrigger', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['EditableText', '@lobehub/ui/es/EditableText/EditableText'],
  ['EditorSlashMenu', '@lobehub/ui/es/EditorSlashMenu/EditorSlashMenu'],
  ['EmojiPicker', '@lobehub/ui/es/EmojiPicker/EmojiPicker'],
  ['Empty', '@lobehub/ui/es/Empty/Empty'],
  ['FileTypeIcon', '@lobehub/ui/es/FileTypeIcon/FileTypeIcon'],
  ['FlexBasic', '@lobehub/ui/es/Flex/FlexBasic'],
  ['Flexbox', '@lobehub/ui/es/Flex/FlexBasic'],
  ['FluentEmoji', '@lobehub/ui/es/FluentEmoji/FluentEmoji'],
  ['FontLoader', '@lobehub/ui/es/FontLoader/index'],
  ['Footer', '@lobehub/ui/es/Footer/Footer'],
  ['Form', '@lobehub/ui/es/Form/index'],
  ['FormGroup', '@lobehub/ui/es/Form/components/FormGroup'],
  ['FormItem', '@lobehub/ui/es/Form/components/FormItem'],
  ['FormModal', '@lobehub/ui/es/FormModal/FormModal'],
  ['FormSubmitFooter', '@lobehub/ui/es/Form/components/FormSubmitFooter'],
  ['FormTitle', '@lobehub/ui/es/Form/components/FormTitle'],
  ['Freeze', '@lobehub/ui/es/Freeze/Freeze'],
  ['Grid', '@lobehub/ui/es/Grid/Grid'],
  ['GroupAvatar', '@lobehub/ui/es/GroupAvatar/GroupAvatar'],
  ['GuideCard', '@lobehub/ui/es/GuideCard/GuideCard'],
  ['HTML_PREVIEW_DEFAULT_SANDBOX', '@lobehub/ui/es/HtmlPreview/const'],
  ['Header', '@lobehub/ui/es/Header/Header'],
  ['Hotkey', '@lobehub/ui/es/Hotkey/Hotkey'],
  ['HotkeyInput', '@lobehub/ui/es/HotkeyInput/HotkeyInput'],
  ['HtmlPreview', '@lobehub/ui/es/HtmlPreview/HtmlPreview'],
  ['Icon', '@lobehub/ui/es/Icon/Icon'],
  ['Image', '@lobehub/ui/es/Image/index'],
  ['ImageSelect', '@lobehub/ui/es/ImageSelect/ImageSelect'],
  ['Input', '@lobehub/ui/es/Input/Input'],
  ['InputNumber', '@lobehub/ui/es/Input/InputNumber'],
  ['InputOPT', '@lobehub/ui/es/Input/InputOPT'],
  ['InputPassword', '@lobehub/ui/es/Input/InputPassword'],
  ['Layout', '@lobehub/ui/es/Layout/index'],
  ['List', '@lobehub/ui/es/List/index'],
  ['ListItem', '@lobehub/ui/es/List/ListItem/index'],
  ['Markdown', '@lobehub/ui/es/Markdown/Markdown'],
  ['MaskShadow', '@lobehub/ui/es/MaskShadow/MaskShadow'],
  ['MaterialFileTypeIcon', '@lobehub/ui/es/MaterialFileTypeIcon/MaterialFileTypeIcon'],
  ['Menu', '@lobehub/ui/es/Menu/Menu'],
  ['Mermaid', '@lobehub/ui/es/Mermaid/Mermaid'],
  ['Meta', '@lobehub/ui/es/ThemeProvider/Meta'],
  ['Modal', '@lobehub/ui/es/Modal/Modal'],
  ['MotionProvider', '@lobehub/ui/es/MotionProvider/index'],
  ['NeuralNetworkLoading', '@lobehub/ui/es/NeuralNetworkLoading/NeuralNetworkLoading'],
  ['Popover', '@lobehub/ui/es/base-ui/Popover/Popover'],
  ['PopoverBackdrop', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverGroup', '@lobehub/ui/es/base-ui/Popover/PopoverGroup'],
  ['PopoverPopup', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverPortal', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverPositioner', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverRoot', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverTriggerElement', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PreviewGroup', '@lobehub/ui/es/Image/PreviewGroup'],
  ['ScrollAreaCorner', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ScrollAreaRoot', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ScrollAreaScrollbar', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ScrollAreaThumb', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ScrollShadow', '@lobehub/ui/es/ScrollShadow/ScrollShadow'],
  ['SearchBar', '@lobehub/ui/es/SearchBar/SearchBar'],
  ['SearchResultCards', '@lobehub/ui/es/Markdown/components/SearchResultCards/index'],
  ['Segmented', '@lobehub/ui/es/Segmented/Segmented'],
  ['Select', '@lobehub/ui/es/Select/Select'],
  ['ShikiLobeTheme', '@lobehub/ui/es/Highlighter/theme/lobe-theme'],
  ['SideNav', '@lobehub/ui/es/SideNav/SideNav'],
  ['Skeleton', '@lobehub/ui/es/Skeleton/index'],
  ['SkeletonAvatar', '@lobehub/ui/es/Skeleton/SkeletonAvatar'],
  ['SkeletonBlock', '@lobehub/ui/es/Skeleton/SkeletonBlock'],
  ['SkeletonButton', '@lobehub/ui/es/Skeleton/SkeletonButton'],
  ['SkeletonParagraph', '@lobehub/ui/es/Skeleton/SkeletonParagraph'],
  ['SkeletonTags', '@lobehub/ui/es/Skeleton/SkeletonTags'],
  ['SkeletonTitle', '@lobehub/ui/es/Skeleton/SkeletonTitle'],
  ['SliderWithInput', '@lobehub/ui/es/SliderWithInput/SliderWithInput'],
  ['Snippet', '@lobehub/ui/es/Snippet/Snippet'],
  ['SortableList', '@lobehub/ui/es/SortableList/SortableList'],
  ['SyntaxHighlighter', '@lobehub/ui/es/Highlighter/SyntaxHighlighter/index'],
  ['SyntaxMermaid', '@lobehub/ui/es/Mermaid/SyntaxMermaid/index'],
  ['Tabs', '@lobehub/ui/es/Tabs/Tabs'],
  ['Tag', '@lobehub/ui/es/Tag/Tag'],
  ['Text', '@lobehub/ui/es/Text/Text'],
  ['TextArea', '@lobehub/ui/es/Input/TextArea'],
  ['ThemeProvider', '@lobehub/ui/es/ThemeProvider/ThemeProvider'],
  ['ThemeSwitch', '@lobehub/ui/es/ThemeSwitch/ThemeSwitch'],
  ['Toc', '@lobehub/ui/es/Toc/Toc'],
  ['TooltipGroup', '@lobehub/ui/es/base-ui/Tooltip/TooltipGroup'],
  ['Typography', '@lobehub/ui/es/Markdown/Typography'],
  ['Video', '@lobehub/ui/es/Video/index'],
  ['createModal', '@lobehub/ui/es/Modal/imperative'],
  ['htmlPreviewContainsScript', '@lobehub/ui/es/HtmlPreview/const'],
  ['isFullHtmlDocument', '@lobehub/ui/es/HtmlPreview/const'],
  ['neutralColors', '@lobehub/ui/es/styles/customTheme'],
  ['neutralColorsSwatches', '@lobehub/ui/es/styles/customTheme'],
  ['preventDefaultAndStopPropagation', '@lobehub/ui/es/utils/dom'],
  ['primaryColors', '@lobehub/ui/es/styles/customTheme'],
  ['setContextMenuInterceptor', '@lobehub/ui/es/base-ui/ContextMenu/store'],
  ['showContextMenu', '@lobehub/ui/es/base-ui/ContextMenu/store'],
  ['toast', '@lobehub/ui/es/base-ui/Toast/imperative'],
];

/** Same-name named exports: `import { X }` stays `import { X }`. */
const sameNameMembers: Array<[string, string]> = [
  ['CLASSNAMES', '@lobehub/ui/es/styles/classNames'],
  ['CodeDiff', '@lobehub/ui/es/CodeDiff/CodeDiff'],
  ['ContextMenuHost', '@lobehub/ui/es/base-ui/ContextMenu/ContextMenuHost'],
  ['ContextMenuTrigger', '@lobehub/ui/es/base-ui/ContextMenu/ContextMenuTrigger'],
  ['DropdownMenuCheckboxItemIndicator', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['Highlighter', '@lobehub/ui/es/Highlighter/Highlighter'],
  ['HtmlPreviewIframe', '@lobehub/ui/es/HtmlPreview/Iframe'],
  ['I18nProvider', '@lobehub/ui/es/i18n/context'],
  ['IconProvider', '@lobehub/ui/es/Icon/components/IconProvider'],
  ['KeyMapEnum', '@lobehub/ui/es/Hotkey/const'],
  ['LOBE_THEME_APP_ID', '@lobehub/ui/es/ThemeProvider/constants'],
  ['LayoutFooter', '@lobehub/ui/es/Layout/components/LayoutFooter'],
  ['LayoutHeader', '@lobehub/ui/es/Layout/components/LayoutHeader'],
  ['LayoutMain', '@lobehub/ui/es/Layout/components/LayoutMain'],
  ['LayoutSidebar', '@lobehub/ui/es/Layout/components/LayoutSidebar'],
  ['LayoutSidebarInner', '@lobehub/ui/es/Layout/components/LayoutSidebarInner'],
  ['LayoutToc', '@lobehub/ui/es/Layout/components/LayoutToc'],
  ['ModalHost', '@lobehub/ui/es/Modal/imperative'],
  ['ModalProvider', '@lobehub/ui/es/Modal/ModalProvider'],
  ['MotionComponent', '@lobehub/ui/es/MotionProvider/index'],
  ['PatchDiff', '@lobehub/ui/es/CodeDiff/PatchDiff'],
  ['PopoverArrow', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverArrowIcon', '@lobehub/ui/es/base-ui/Popover/ArrowIcon'],
  ['PopoverProvider', '@lobehub/ui/es/base-ui/Popover/context'],
  ['ScrollArea', '@lobehub/ui/es/base-ui/ScrollArea/ScrollArea'],
  ['ScrollAreaContent', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ToastHost', '@lobehub/ui/es/base-ui/Toast/imperative'],
  ['Tooltip', '@lobehub/ui/es/base-ui/Tooltip/Tooltip'],
  ['closeContextMenu', '@lobehub/ui/es/base-ui/ContextMenu/store'],
  ['combineKeys', '@lobehub/ui/es/Hotkey/utils'],
  ['copyToClipboard', '@lobehub/ui/es/utils/copyToClipboard'],
  ['findCustomThemeName', '@lobehub/ui/es/styles/customTheme'],
  ['genCdnUrl', '@lobehub/ui/es/utils/genCdnUrl'],
  ['generateColorNeutralPalette', '@lobehub/ui/es/styles/theme/generateColorPalette'],
  ['highlighterThemes', '@lobehub/ui/es/Highlighter/const'],
  ['mermaidThemes', '@lobehub/ui/es/Mermaid/const'],
  ['placementMap', '@lobehub/ui/es/utils/placement'],
  ['preprocessMarkdownContent', '@lobehub/ui/es/hooks/useMarkdown/utils'],
  ['preventDefault', '@lobehub/ui/es/utils/dom'],
  ['rehypeCustomFootnotes', '@lobehub/ui/es/Markdown/plugins/rehypeCustomFootnotes'],
  ['rehypeKatexDir', '@lobehub/ui/es/Markdown/plugins/rehypeKatexDir'],
  ['rehypeStreamAnimated', '@lobehub/ui/es/Markdown/plugins/rehypeStreamAnimated'],
  ['remarkBr', '@lobehub/ui/es/Markdown/plugins/remarkBr'],
  ['remarkColor', '@lobehub/ui/es/Markdown/plugins/remarkColor'],
  ['remarkCustomFootnotes', '@lobehub/ui/es/Markdown/plugins/remarkCustomFootnotes'],
  ['remarkGfmPlus', '@lobehub/ui/es/Markdown/plugins/remarkGfmPlus'],
  ['remarkVideo', '@lobehub/ui/es/Markdown/plugins/remarkVideo'],
  ['renderDropdownMenuItems', '@lobehub/ui/es/base-ui/DropdownMenu/renderItems'],
  ['useAppElement', '@lobehub/ui/es/ThemeProvider/AppElementContext'],
  ['useCdnFn', '@lobehub/ui/es/ConfigProvider/index'],
  ['usePopoverPortalContainer', '@lobehub/ui/es/base-ui/Popover/PopoverPortal'],
  ['useTranslation', '@lobehub/ui/es/i18n/useTranslation'],
];

/**
 * Aliased exports: `import { Orig as Alias }` keeps its alias.
 * Each entry gets its own plugin instance with an exact-match pattern
 * (`^Orig as Alias$`) and a template that re-emits the alias.
 */
const aliasedMembers: Array<[string, string, string]> = [
  // [alias (barrel name), deep path, original export name]
  ['HTML_PREVIEW_DEFAULT_HEIGHT', '@lobehub/ui/es/HtmlPreview/const', 'DEFAULT_HEIGHT'],
  [
    'HTML_PREVIEW_RESIZE_MESSAGE',
    '@lobehub/ui/es/HtmlPreview/injectAutoHeightScript',
    'AUTO_HEIGHT_MESSAGE_TYPE',
  ],
  ['LobeUIProvider', '@lobehub/ui/es/i18n/context', 'I18nProvider'],
  ['lobeCustomStylish', '@lobehub/ui/es/styles/theme/customStylish', 'generateCustomStylish'],
  ['lobeCustomToken', '@lobehub/ui/es/styles/theme/customToken', 'generateCustomToken'],
  ['lobeStaticStylish', '@lobehub/ui/es/styles/theme/customStylishStatic', 'staticStylish'],
  ['menuSharedStyles', '@lobehub/ui/es/base-ui/DropdownMenu/sharedStyle', 'styles'],
];

/**
 * Rewrites @lobehub/ui barrel imports to deep es/ imports.
 * Must run before React/plugin transforms; mirrors lobeIconImports behavior.
 */
export const lobeUiImports = (): PluginOption[] => {
  const plugins: PluginOption[] = [
    // Default-export components: `import { X }` becomes `import X from ...`
    transformImports({
      '@lobehub/ui': {
        preventFullImport: true,
        transform: defaultMembers,
      },
    }),

    // Same-name named exports stay named.
    transformImports({
      '@lobehub/ui': {
        preventFullImport: true,
        skipDefaultConversion: true,
        transform: sameNameMembers,
      },
    }),

    // Aliased named exports (`import { Orig as Alias }`): transform-imports
    // drops the original name under skipDefaultConversion, so rewrite these
    // with a small dedicated plugin that preserves `Orig as Alias`.
    // Only 7 members use aliases; all other barrel imports go through
    // transform-imports above (which handles mixed specifier lists itself).
    {
      enforce: 'pre',
      name: 'lobe-ui-aliased-imports',
      transform(code, id) {
        if (!/\.[cm]?[jt]sx?$/.test(id) || !code.includes('@lobehub/ui')) return;
        let changed = false;
        const found = new Set<string>();
        const out = code.replaceAll(
          /import\s*\{([^}]+)\}\s*from\s*(['"])@lobehub\/ui\2/g,
          (full, specifiers: string, quote: string) => {
            const parts = specifiers
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const rewritten: string[] = [];
            const rest: string[] = [];
            for (const part of parts) {
              const m = part.match(/^(\S+)\s+as\s+(\S+)$/);
              if (!m) {
                rest.push(part);
                continue;
              }
              const [, orig, alias] = m;
              const entry = aliasedMembers.find(([a, , o]) => a === alias && o === orig);
              if (!entry) {
                rest.push(part);
                continue;
              }
              found.add(alias);
              rewritten.push(`import { ${orig} as ${alias} } from ${quote}${entry[1]}${quote};`);
            }
            if (!rewritten.length) return full;
            changed = true;
            const kept = rest.length ? `import { ${rest.join(', ')} } from '@lobehub/ui';` : '';
            return [...rewritten, kept].filter(Boolean).join('\n');
          },
        );
        if (!changed) return;
        return out;
      },
    },
  ];

  for (const plugin of plugins) {
    // transform-imports only processes known extensions by default - include .mjs
    // (mirrors lobeIconImports' includeModuleExtensions). Skip the custom
    // alias plugin (a plain object without a transform filter shape).
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin) || !('transform' in plugin))
      continue;
    const transform = (plugin as { transform?: unknown }).transform;
    if (typeof transform === 'object' && transform) {
      (plugin as { transform: unknown }).transform = {
        ...(transform as Record<string, unknown>),
        filter: {
          ...(transform as { filter?: Record<string, unknown> }).filter,
          id: /\.[cm]?[jt]sx?$/,
        },
      };
    }
  }

  return plugins;
};
