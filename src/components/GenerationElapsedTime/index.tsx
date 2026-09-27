'use client';

import { Text } from '@lobehub/ui';
import { useEffect, useRef, useState } from 'react';

import { formatGenerationElapsedTime } from './formatElapsedTime';

interface GenerationElapsedTimeProps {
  isActive: boolean;
  /** Known start timestamp (ms); takes precedence over the stored/first-mount time. */
  startTime?: number;
  /** Stable key for the timer (generation id, tool call id, ...). */
  timerKey: string;
}

const getSessionStorageKey = (timerKey: string) => `generation_start_time_${timerKey}`;

/**
 * Display elapsed time for a running generation
 * - Less than 1 minute: show seconds with 0.1s precision
 * - 1 minute or more: show whole minutes and seconds
 * - Uses sessionStorage to maintain accurate timing across page refreshes
 */
export function GenerationElapsedTime({
  timerKey,
  isActive,
  startTime,
}: GenerationElapsedTimeProps) {
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(0);

  useEffect(() => {
    if (!isActive) {
      // If not active, clear the timer and reset elapsed time
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }

      // Clear data from sessionStorage
      const storageKey = getSessionStorageKey(timerKey);
      sessionStorage.removeItem(storageKey);
      setElapsedMs(null);
      return;
    }

    const storageKey = getSessionStorageKey(timerKey);

    const clientStartTime = (() => {
      if (startTime !== undefined) {
        sessionStorage.setItem(storageKey, startTime.toString());
        return startTime;
      }

      const stored = sessionStorage.getItem(storageKey);
      if (stored) return Number(stored);

      const now = Date.now();
      sessionStorage.setItem(storageKey, now.toString());
      return now;
    })();

    const update = (timestamp: number) => {
      if (timestamp - lastUpdateRef.current >= 100) {
        setElapsedMs(Math.max(0, Date.now() - clientStartTime));
        lastUpdateRef.current = timestamp;
      }
      frameRef.current = requestAnimationFrame(update);
    };

    frameRef.current = requestAnimationFrame(update);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [timerKey, isActive, startTime]);

  return (
    <Text code fontSize={10} type={'secondary'}>
      {elapsedMs === null ? '' : formatGenerationElapsedTime(elapsedMs)}
    </Text>
  );
}

export default GenerationElapsedTime;
