import Image from 'next/image'

interface ProductPhoneProps {
  src: string
  alt: string
  className?: string
  priority?: boolean
}

export function ProductPhone({
  src,
  alt,
  className,
  priority = false,
}: ProductPhoneProps) {
  return (
    <div className={`relative ${className ?? 'w-[292px]'}`}>
      <div
        className="absolute -inset-4 rounded-[2.3rem] bg-primary/10 blur-2xl"
        aria-hidden="true"
      />
      <div className="relative rounded-[2.2rem] bg-surface-container-lowest p-[6px] shadow-2xl shadow-[#010b12]/70 ring-1 ring-white/10">
        <div className="relative aspect-[9/20] overflow-hidden rounded-[1.9rem] border border-outline-variant/55 bg-surface-container-lowest ring-1 ring-primary/20">
          <Image
            src={src}
            alt={alt}
            fill
            priority={priority}
            loading={priority ? 'eager' : 'lazy'}
            sizes="(max-width: 768px) 260px, 304px"
            className="object-cover object-top"
          />
        </div>
      </div>
      <div
        className="mx-auto -mt-3 h-10 w-56 rounded-full bg-surface-container-lowest/45 blur-2xl"
        aria-hidden="true"
      />
    </div>
  )
}
