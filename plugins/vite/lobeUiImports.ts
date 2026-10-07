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
 * (v5.24.0). Regenerate when upgrading @lobehub/ui. Rule: a member uses a
 * default import only if the barrel imports it with `import X from`;
 * `{ X }`-style barrel imports must stay named (base-ui atoms modules,
 * Modal/imperative, styles, utils, and stores have no default export).
 * Deliberately unmapped: ErrorBoundary (barrel re-exports it from the
 * external react-error-boundary package, which app code cannot resolve
 * directly under pnpm).
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
  ['NeuralNetworkLoading', '@lobehub/ui/es/NeuralNetworkLoading/NeuralNetworkLoading'],
  ['Popover', '@lobehub/ui/es/base-ui/Popover/Popover'],
  ['PopoverGroup', '@lobehub/ui/es/base-ui/Popover/PopoverGroup'],
  ['PreviewGroup', '@lobehub/ui/es/Image/PreviewGroup'],
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
  ['useModalContext', '@lobehub/ui/es/Modal/ModalProvider'],
  ['useMotionComponent', '@lobehub/ui/es/MotionProvider/index'],
  ['usePopoverContext', '@lobehub/ui/es/base-ui/Popover/context'],
  ['usePopoverPortalContainer', '@lobehub/ui/es/base-ui/Popover/PopoverPortal'],
  ['useToast', '@lobehub/ui/es/base-ui/Toast/imperative'],
  ['useTranslation', '@lobehub/ui/es/i18n/useTranslation'],
  // base-ui atoms modules only have named exports — never default-import them.
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
  ['DropdownMenuTrigger', '@lobehub/ui/es/base-ui/DropdownMenu/atoms'],
  ['PopoverBackdrop', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverPopup', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverPortal', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverPositioner', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverRoot', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverTriggerElement', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['PopoverViewport', '@lobehub/ui/es/base-ui/Popover/atoms'],
  ['ScrollAreaCorner', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ScrollAreaRoot', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ScrollAreaScrollbar', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ScrollAreaThumb', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['ScrollAreaViewport', '@lobehub/ui/es/base-ui/ScrollArea/atoms'],
  ['MotionProvider', '@lobehub/ui/es/MotionProvider/index'],
  ['createModal', '@lobehub/ui/es/Modal/imperative'],
  ['createRawModal', '@lobehub/ui/es/Modal/imperative'],
  ['generateColorPalette', '@lobehub/ui/es/styles/theme/generateColorPalette'],
  ['isFullHtmlDocument', '@lobehub/ui/es/HtmlPreview/const'],
  ['isHtmlContentClosed', '@lobehub/ui/es/HtmlPreview/const'],
  ['neutralColors', '@lobehub/ui/es/styles/customTheme'],
  ['neutralColorsSwatches', '@lobehub/ui/es/styles/customTheme'],
  ['preventDefaultAndStopPropagation', '@lobehub/ui/es/utils/dom'],
  ['primaryColors', '@lobehub/ui/es/styles/customTheme'],
  ['primaryColorsSwatches', '@lobehub/ui/es/styles/customTheme'],
  ['setContextMenuInterceptor', '@lobehub/ui/es/base-ui/ContextMenu/store'],
  ['showContextMenu', '@lobehub/ui/es/base-ui/ContextMenu/store'],
  ['stopPropagation', '@lobehub/ui/es/utils/dom'],
  ['toFloatingUIPlacement', '@lobehub/ui/es/utils/placement'],
  ['toast', '@lobehub/ui/es/base-ui/Toast/imperative'],
  ['updateContextMenuItems', '@lobehub/ui/es/base-ui/ContextMenu/store'],
];

/**
 * Aliased exports: the barrel exports these under a different name
 * (`Orig as Alias`), so `import { Orig as Alias }` and `import { Alias }`
 * both rewrite to `import { Orig [as Local] }` from the deep path.
 * Each entry: [alias (barrel name), deep path, original export name].
 */
const aliasedMembers: Array<[string, string, string]> = [
  // [alias (barrel name), deep path, original export name]
  ['HTML_PREVIEW_DEFAULT_HEIGHT', '@lobehub/ui/es/HtmlPreview/const', 'DEFAULT_HEIGHT'],
  ['HTML_PREVIEW_DEFAULT_SANDBOX', '@lobehub/ui/es/HtmlPreview/const', 'DEFAULT_SANDBOX'],
  [
    'HTML_PREVIEW_RESIZE_MESSAGE',
    '@lobehub/ui/es/HtmlPreview/injectAutoHeightScript',
    'AUTO_HEIGHT_MESSAGE_TYPE',
  ],
  ['LobeUIProvider', '@lobehub/ui/es/i18n/context', 'I18nProvider'],
  ['htmlPreviewContainsScript', '@lobehub/ui/es/HtmlPreview/const', 'containsScript'],
  ['lobeCustomStylish', '@lobehub/ui/es/styles/theme/customStylish', 'generateCustomStylish'],
  ['lobeCustomToken', '@lobehub/ui/es/styles/theme/customToken', 'generateCustomToken'],
  ['lobeStaticStylish', '@lobehub/ui/es/styles/theme/customStylishStatic', 'staticStylish'],
  ['menuSharedStyles', '@lobehub/ui/es/base-ui/DropdownMenu/sharedStyle', 'styles'],
];

/**
 * Rewrites @lobehub/ui barrel imports to deep es/ imports in a single pass.
 * Must run before React/plugin transforms; mirrors lobeIconImports behavior.
 *
 * A single pass is required: the rewrite tool used before processes one
 * member class per plugin instance and rewrites members unknown to that
 * instance to `from '<Member>'`, so instances clobber each other on mixed
 * imports. Here every specifier is routed exactly once.
 */
export const lobeUiImports = (): PluginOption[] => {
  const defaultPaths = new Map(defaultMembers);
  const namedPaths = new Map(sameNameMembers);
  const aliasOrigins = new Map(
    aliasedMembers.map(([alias, from, orig]) => [alias, { from, orig }]),
  );

  return [
    {
      enforce: 'pre',
      name: 'lobe-ui-imports',
      transform(code, id) {
        if (!/\.[cm]?[jt]sx?$/.test(id) || !code.includes('@lobehub/ui')) return;
        if (
          /import\s+(?:\*\s+as\s+\S+|['"])@lobehub\/ui['"]/.test(code) ||
          /import\s*\(\s*['"]@lobehub\/ui['"]\s*\)/.test(code)
        ) {
          throw new Error(
            `lobe-ui-imports: namespace, side-effect, or dynamic imports from '@lobehub/ui' pull in the whole barrel: ${id}`,
          );
        }
        let changed = false;
        const out = code.replaceAll(
          /import\s+(type\s+)?\{([^}]+)\}\s*from\s*(['"])@lobehub\/ui\3/g,
          (full, typeKeyword: string | undefined, specifiers: string, quote: string) => {
            const typePrefix = typeKeyword ?? '';
            const rewritten: Array<string> = [];
            const rest: Array<string> = [];
            for (const part of specifiers
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)) {
              // Each specifier: [type] Original [as Local]
              const m = part.match(/^(type\s+)?(\S+)(?:\s+as\s+(\S+))?$/);
              if (!m) {
                rest.push(part);
                continue;
              }
              const [, inlineType, specOrig, specLocal] = m;
              const prefix = typePrefix || inlineType || '';
              const local = specLocal ?? specOrig;
              const defaultPath = defaultPaths.get(specOrig);
              if (defaultPath) {
                rewritten.push(`import ${prefix}${local} from ${quote}${defaultPath}${quote}`);
              } else {
                const namedPath = namedPaths.get(specOrig);
                // Aliased barrel exports can be imported either as
                // `Orig as Alias` or directly as `Alias` (optionally
                // re-aliased by the importer), so check both names.
                const aliasEntry = namedPath
                  ? null
                  : (aliasOrigins.get(specLocal) ?? aliasOrigins.get(specOrig));
                const from = namedPath ?? aliasEntry?.from;
                const orig = aliasEntry?.orig ?? specOrig;
                if (!from) {
                  rest.push(part);
                  continue;
                }
                rewritten.push(
                  `import ${prefix}{ ${orig}${local === orig ? '' : ` as ${local}`} } from ${quote}${from}${quote}`,
                );
              }
            }
            if (!rewritten.length) return full;
            changed = true;
            const kept = rest.length
              ? `import ${typePrefix}{ ${rest.join(', ')} } from '@lobehub/ui'`
              : '';
            return [...rewritten, kept].filter(Boolean).join('\n');
          },
        );
        if (!changed) return;
        return out;
      },
    },
  ];
};

export const __testing = {
  aliasedMembers,
  defaultMembers,
  sameNameMembers,
};
