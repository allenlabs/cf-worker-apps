// A compact, searchable emoji picker (Phase 11). No heavy dependency — a
// curated set of ~250 common emoji with keyword aliases is enough for page
// icons. Opens as a small popover; choosing an emoji calls onPick, and a
// "Remove" action clears the icon.
//
// Kept self-contained (no external emoji-data dep) so it bundles cleanly under
// the TanStack Start / Cloudflare Workers build.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';

/** [emoji, ...search aliases] — aliases power the search box. */
const EMOJI: [string, ...string[]][] = [
  ['📄', 'page', 'document', 'file'],
  ['📝', 'memo', 'note', 'write'],
  ['📚', 'books', 'library', 'study'],
  ['📒', 'ledger', 'notebook'],
  ['📅', 'calendar', 'date', 'schedule'],
  ['📆', 'calendar', 'tearoff'],
  ['🗓️', 'calendar', 'spiral'],
  ['📊', 'chart', 'bar', 'stats'],
  ['📈', 'chart', 'up', 'growth'],
  ['📉', 'chart', 'down'],
  ['📌', 'pin', 'pushpin'],
  ['📍', 'pin', 'location'],
  ['🔖', 'bookmark', 'tag'],
  ['🏷️', 'label', 'tag'],
  ['💡', 'idea', 'light', 'bulb', 'tip'],
  ['🔥', 'fire', 'hot', 'lit'],
  ['⭐', 'star', 'favorite'],
  ['🌟', 'star', 'glow'],
  ['✨', 'sparkles', 'shiny'],
  ['🎯', 'target', 'goal', 'dart'],
  ['🚀', 'rocket', 'launch', 'ship'],
  ['🎉', 'party', 'celebrate', 'tada'],
  ['🎨', 'art', 'palette', 'design'],
  ['🎵', 'music', 'note'],
  ['🎸', 'guitar', 'music'],
  ['📷', 'camera', 'photo'],
  ['🎥', 'movie', 'film', 'video'],
  ['💻', 'laptop', 'computer', 'code'],
  ['🖥️', 'desktop', 'computer'],
  ['⌨️', 'keyboard', 'type'],
  ['🖱️', 'mouse', 'click'],
  ['📱', 'phone', 'mobile'],
  ['🔋', 'battery', 'power'],
  ['🔌', 'plug', 'power'],
  ['💾', 'save', 'disk', 'floppy'],
  ['💿', 'cd', 'disc'],
  ['🗂️', 'folders', 'organize'],
  ['📁', 'folder', 'directory'],
  ['📂', 'folder', 'open'],
  ['🗃️', 'cardbox', 'files'],
  ['🗄️', 'cabinet', 'files'],
  ['📦', 'box', 'package', 'parcel'],
  ['✅', 'check', 'done', 'complete'],
  ['☑️', 'checkbox', 'todo'],
  ['✔️', 'check', 'tick'],
  ['❌', 'cross', 'no', 'wrong'],
  ['⚠️', 'warning', 'caution'],
  ['❓', 'question', 'help'],
  ['❗', 'exclamation', 'important'],
  ['💬', 'speech', 'comment', 'chat'],
  ['💭', 'thought', 'bubble'],
  ['📣', 'megaphone', 'announce'],
  ['📢', 'loudspeaker', 'announce'],
  ['🔔', 'bell', 'notify'],
  ['🔕', 'bell', 'mute'],
  ['🔍', 'search', 'magnify', 'find'],
  ['🔎', 'search', 'magnify'],
  ['🔑', 'key', 'access', 'password'],
  ['🔒', 'lock', 'secure', 'private'],
  ['🔓', 'unlock', 'open'],
  ['🛡️', 'shield', 'security'],
  ['⚙️', 'gear', 'settings', 'config'],
  ['🔧', 'wrench', 'fix', 'tool'],
  ['🔨', 'hammer', 'build', 'tool'],
  ['🛠️', 'tools', 'build'],
  ['🧰', 'toolbox', 'tools'],
  ['🧪', 'test', 'experiment', 'lab'],
  ['🔬', 'microscope', 'science'],
  ['🧬', 'dna', 'biology'],
  ['🌍', 'earth', 'world', 'globe'],
  ['🗺️', 'map', 'world'],
  ['🧭', 'compass', 'direction'],
  ['🏠', 'home', 'house'],
  ['🏢', 'office', 'building', 'work'],
  ['🏆', 'trophy', 'win', 'award'],
  ['🥇', 'gold', 'medal', 'first'],
  ['🎖️', 'medal', 'award'],
  ['💰', 'money', 'bag', 'cash'],
  ['💵', 'money', 'dollar', 'cash'],
  ['💳', 'card', 'credit', 'pay'],
  ['🧾', 'receipt', 'invoice'],
  ['📧', 'email', 'mail'],
  ['📨', 'mail', 'incoming'],
  ['✉️', 'envelope', 'mail'],
  ['📮', 'mailbox', 'post'],
  ['📤', 'outbox', 'send'],
  ['📥', 'inbox', 'receive'],
  ['🗒️', 'notepad', 'note'],
  ['📋', 'clipboard', 'list', 'copy'],
  ['📃', 'page', 'document'],
  ['📜', 'scroll', 'document'],
  ['📰', 'newspaper', 'news'],
  ['🧠', 'brain', 'mind', 'think'],
  ['❤️', 'heart', 'love', 'red'],
  ['🧡', 'heart', 'orange'],
  ['💛', 'heart', 'yellow'],
  ['💚', 'heart', 'green'],
  ['💙', 'heart', 'blue'],
  ['💜', 'heart', 'purple'],
  ['🖤', 'heart', 'black'],
  ['👍', 'thumbsup', 'like', 'yes'],
  ['👎', 'thumbsdown', 'dislike', 'no'],
  ['👏', 'clap', 'applause'],
  ['🙌', 'raise', 'celebrate'],
  ['🙏', 'pray', 'thanks', 'please'],
  ['💪', 'muscle', 'strong'],
  ['🤝', 'handshake', 'deal', 'agree'],
  ['👀', 'eyes', 'look', 'watch'],
  ['🧑‍💻', 'developer', 'coder', 'engineer'],
  ['👤', 'person', 'user', 'profile'],
  ['👥', 'people', 'team', 'users'],
  ['🗣️', 'speaking', 'talk'],
  ['🌱', 'seedling', 'grow', 'plant'],
  ['🌳', 'tree', 'nature'],
  ['🌸', 'blossom', 'flower'],
  ['🌈', 'rainbow', 'pride'],
  ['☀️', 'sun', 'sunny', 'day'],
  ['🌙', 'moon', 'night'],
  ['⛅', 'cloud', 'weather'],
  ['❄️', 'snow', 'cold', 'winter'],
  ['💧', 'water', 'drop'],
  ['🌊', 'wave', 'ocean', 'sea'],
  ['⚡', 'lightning', 'bolt', 'fast'],
  ['🔆', 'bright', 'high'],
  ['🕐', 'clock', 'time'],
  ['⏰', 'alarm', 'clock', 'time'],
  ['⏳', 'hourglass', 'wait', 'time'],
  ['⌛', 'hourglass', 'done'],
  ['🏁', 'flag', 'finish', 'race'],
  ['🚩', 'flag', 'marker'],
  ['🏷', 'tag', 'price'],
  ['🍀', 'clover', 'luck'],
  ['🐛', 'bug', 'insect', 'issue'],
  ['🐞', 'ladybug', 'bug'],
  ['🦋', 'butterfly', 'transform'],
  ['🐳', 'whale', 'docker'],
  ['🐱', 'cat', 'kitty'],
  ['🐶', 'dog', 'puppy'],
  ['🦊', 'fox', 'firefox'],
  ['🦉', 'owl', 'wise', 'night'],
  ['🍎', 'apple', 'fruit'],
  ['🍌', 'banana', 'fruit'],
  ['🍔', 'burger', 'food'],
  ['🍕', 'pizza', 'food'],
  ['☕', 'coffee', 'drink'],
  ['🍵', 'tea', 'drink'],
  ['🍺', 'beer', 'drink'],
  ['🎮', 'game', 'controller', 'play'],
  ['🎲', 'dice', 'random', 'game'],
  ['🧩', 'puzzle', 'piece'],
  ['🎁', 'gift', 'present'],
  ['🎈', 'balloon', 'party'],
  ['🔮', 'crystal', 'magic', 'future'],
  ['💎', 'gem', 'diamond', 'valuable'],
  ['🪄', 'wand', 'magic'],
];

interface EmojiPickerProps {
  /** Choose an emoji as the page icon. */
  onPick: (emoji: string) => void;
  /** Clear the icon. Omit when there's nothing to clear (e.g. a reaction picker). */
  onRemove?: () => void;
  /** Dismiss the picker (outside click / Escape). */
  onClose: () => void;
}

export function EmojiPicker({ onPick, onRemove, onClose }: EmojiPickerProps) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EMOJI;
    return EMOJI.filter(([, ...aliases]) => aliases.some((a) => a.includes(q)));
  }, [query]);

  return (
    <div
      ref={ref}
      className="ae-pop-in absolute left-0 top-12 z-30 w-72 bg-white dark:bg-gray-800 dark:text-gray-100 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2"
      data-testid="emoji-picker"
    >
      <div className="flex items-center gap-1 mb-2">
        <input
          autoFocus
          className="flex-1 text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 rounded px-2 py-1 outline-none focus:border-gray-400"
          placeholder={t('emoji.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('emoji.search')}
        />
        {onRemove ? (
          <button
            className="text-xs px-2 py-1 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700 whitespace-nowrap"
            onClick={onRemove}
            data-testid="emoji-remove"
          >
            {t('emoji.remove')}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-8 gap-0.5 max-h-52 overflow-y-auto">
        {results.map(([emoji, ...aliases]) => (
          <button
            key={emoji}
            type="button"
            className="text-xl rounded hover:bg-gray-100 dark:hover:bg-gray-700 aspect-square flex items-center justify-center"
            title={aliases[0]}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
        {results.length === 0 ? (
          <p className="col-span-8 text-xs text-gray-400 dark:text-gray-500 py-3 text-center">{t('emoji.noResults')}</p>
        ) : null}
      </div>
    </div>
  );
}
