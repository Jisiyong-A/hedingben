'use client';

import { motion } from 'framer-motion';
import { Note } from '../../types/xiaohongshu';
import { MatchSource } from '../search/SearchResultMeta';
import { NoteCard } from './NoteCard';

export function NoteGrid({
  notes,
  matchSources,
  activeFilter,
  onOpen,
  onDragStart,
  onDragEnd,
  compact,
}: {
  notes: Note[];
  matchSources?: Record<string, MatchSource[]>;
  activeFilter: boolean;
  onOpen: (note: Note) => void;
  onDragStart: (noteId: string) => void;
  onDragEnd: () => void;
  compact?: boolean;
}) {
  return (
    <motion.div
      layout
      style={{
        display: 'grid',
        gridTemplateColumns: compact ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fill, minmax(224px, 1fr))',
        gap: compact ? 10 : 14,
      }}
    >
      {notes.map((note, index) => (
        <NoteCard
          key={note.id}
          note={note}
          index={index}
          dimmed={activeFilter}
          matchSources={matchSources?.[note.id]}
          onClick={() => onOpen(note)}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          compact={compact}
        />
      ))}
    </motion.div>
  );
}
