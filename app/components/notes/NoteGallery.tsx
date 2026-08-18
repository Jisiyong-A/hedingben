'use client';

/** Image carousel — thumbnail rail + main stage. */
export function NoteGallery({
  imageUrls,
  activeImageIndex,
  onSelect,
  onImageFailed,
  compact = false,
}: {
  imageUrls: string[];
  activeImageIndex: number;
  onSelect: (index: number) => void;
  onImageFailed: (url: string) => void;
  compact?: boolean;
}) {
  const activeUrl = imageUrls[Math.min(activeImageIndex, Math.max(imageUrls.length - 1, 0))];

  return (
    <div
      style={{
        flex: compact ? '0 0 auto' : '0 0 58%',
        display: 'flex',
        minWidth: 0,
        position: 'relative',
        borderRight: compact ? 'none' : 'var(--border-hairline)',
        background: '#060607',
        width: compact ? '100%' : undefined,
      }}
    >
      {!compact && imageUrls.length > 1 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            overflowY: 'auto',
            padding: '14px 8px 14px 12px',
            borderRight: 'var(--border-hairline)',
            flexShrink: 0,
            background: '#0B0B0D',
          }}
        >
          {imageUrls.map((imageUrl, index) => (
            <button
              key={imageUrl}
              type="button"
              onClick={() => onSelect(index)}
              aria-label={`查看第 ${index + 1} 张图片`}
              style={{
                width: 52,
                height: 66,
                padding: 0,
                flexShrink: 0,
                overflow: 'hidden',
                borderRadius: 'var(--radius-2)',
                border: index === activeImageIndex ? '1px solid var(--text)' : 'var(--border-hairline)',
                opacity: index === activeImageIndex ? 1 : 0.45,
                cursor: 'pointer',
                background: '#000',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt=""
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={() => onImageFailed(imageUrl)}
              />
            </button>
          ))}
        </div>
      )}

      {activeUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={activeUrl}
          alt=""
          style={
            compact
              ? { flex: '0 0 auto', width: '100%', maxHeight: '55vh', objectFit: 'contain', display: 'block', padding: 0 }
              : { flex: 1, minWidth: 0, objectFit: 'contain', display: 'block', padding: 18 }
          }
          onError={() => onImageFailed(activeUrl)}
        />
      ) : (
        <div
          style={
            compact
              ? { flex: '0 0 auto', width: '100%', height: '55vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }
              : { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }
          }
        >
          <div className="pixel-block" style={{ width: 120, height: 120, borderRadius: 'var(--radius-3)' }} />
        </div>
      )}

      {compact && imageUrls.length > 1 && (
        <div
          style={{
            position: 'absolute',
            bottom: 10,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            gap: 6,
            zIndex: 5,
          }}
        >
          {imageUrls.map((imageUrl, index) => (
            <button
              key={imageUrl}
              type="button"
              onClick={() => onSelect(index)}
              aria-label={`查看第 ${index + 1} 张图片`}
              style={{
                width: 5,
                height: 5,
                padding: 0,
                borderRadius: '50%',
                border: 'none',
                cursor: 'pointer',
                background: index === activeImageIndex ? 'var(--accent)' : 'rgba(255,255,255,0.55)',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
