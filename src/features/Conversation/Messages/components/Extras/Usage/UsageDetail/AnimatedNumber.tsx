import { memo, useEffect, useRef, useState } from 'react';

interface AnimatedNumberProps {
  duration?: number;
  formatter?: (value: number) => string;
  value: number;
}

const AnimatedNumber = memo<AnimatedNumberProps>(({ value, duration = 3000, formatter }) => {
  const [displayValue, setDisplayValue] = useState(value);
  const frameRef = useRef<number>(undefined);
  // Last painted value. Every new leg starts here — never from a stale leg
  // start — so a correction arriving mid-flight (streaming usage revising
  // down) continues smoothly instead of snapping back and re-climbing, which
  // read as the counter jumping backward.
  const paintedRef = useRef(value);

  useEffect(() => {
    const startValue = paintedRef.current;
    if (startValue === value) {
      // Already on screen: settle exactly (also absorbs float residue).
      setDisplayValue(value);
      return;
    }

    const diff = value - startValue;
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Apply easeOutCubic easing function
      const easeProgress = 1 - (1 - progress) ** 3;
      const current = startValue + diff * easeProgress;

      paintedRef.current = current;
      setDisplayValue(current);

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      }
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [value, duration]);

  return formatter ? formatter(displayValue) : displayValue.toString();
});

export default AnimatedNumber;
