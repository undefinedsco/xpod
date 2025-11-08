import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import type * as Transport from 'winston-transport';
import type { TransformableInfo } from 'logform';
import type { Logger, LogMetadata, LoggerFactory } from '@solid/community-server';
import { WinstonLogger } from '@solid/community-server';


interface ConfigurableLoggerOptions {
  fileName?: string;
  maxSize?: string;
  maxFiles?: string;
  format?: string;
  showLocation?: boolean;
}

export class ConfigurableLoggerFactory implements LoggerFactory {
  private readonly level: string;
  private readonly fileName: string;
  private readonly maxSize: string;
  private readonly maxFiles: string;
  private readonly showLocation: boolean;

  public constructor(level: string, options: ConfigurableLoggerOptions = {}) {
    this.level = level;
    this.fileName = options.fileName || './logs/application-%DATE%.log';
    this.maxSize = options.maxSize || '10m';
    this.maxFiles = options.maxFiles || '14d';
    this.showLocation = options.showLocation ?? false;
  }

  private readonly clusterInfo = (meta: LogMetadata): string => {
    if (meta.isPrimary) {
      return 'Primary';
    }
    return `W-${meta.pid ?? '???'}`;
  };

  public createLogger(label: string): Logger {
    return new WinstonLogger(createLogger({
      level: this.level,
      format: this.getFormat(label),
      transports: this.createTransports(label),
    }));
  }

  protected createTransports(label: string): Transport[] {
    return [
      new transports.Console({
        format: format.combine(
          format.colorize(),
          this.getFormat(label),
        ),
      }),
      new DailyRotateFile({
        filename: this.fileName,
        datePattern: 'YYYY-MM-DD',
        maxSize: this.maxSize,
        maxFiles: this.maxFiles,
      }),
    ];
  }

  protected getFormat(label: string) {
    return format.combine(
      format.label({ label }),
      format.timestamp(),
      format.metadata({ fillExcept: [ 'level', 'timestamp', 'label', 'message' ]}),
      format.printf(
        ({ level: levelInner, message, label: labelInner, timestamp, metadata: meta }: TransformableInfo): string => {
          const clusterInfo = this.clusterInfo(meta as LogMetadata);
          
          // Use simplified class name when showLocation is enabled, otherwise use full label
          let displayLabel = labelInner;
          
          if (this.showLocation && labelInner) {
            // Extract class name from label (typically like "MyClass" or "path/to/MyClass")
            const className = labelInner.split('/').pop();
            if (className && className !== 'Object') {
              displayLabel = className;
            }
          }
          
          return `${timestamp} [${displayLabel}] {${clusterInfo}} ${levelInner}: ${message}`;
        },
      ),
    );
  }
}
