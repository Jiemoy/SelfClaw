/**
 * 将字节数转换为人类可读的格式
 * @param bytes 字节数
 * @returns 人类可读的字符串
 */
export function bytesToHumanReadable(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 缓存机制
interface CacheItem {
  size: number;
  timestamp: number;
}

const directorySizeCache = new Map<string, CacheItem>();
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

/**
 * 计算目录大小（优化版）
 * @param dirPath 目录路径
 * @param onProgress 进度回调函数
 * @returns 目录大小（字节）
 */
export async function calculateDirectorySize(
  dirPath: string,
  onProgress?: (current: number, total: number) => void
): Promise<number> {
  // 检查缓存
  const cachedItem = directorySizeCache.get(dirPath);
  const now = Date.now();
  
  if (cachedItem && (now - cachedItem.timestamp) < CACHE_DURATION) {
    return cachedItem.size;
  }
  
  let totalSize = 0;
  let totalFiles = 0;
  let processedFiles = 0;
  
  try {
    const { readDir, readFile } = await import('@tauri-apps/plugin-fs');
    
    // 首先计算总文件数
    async function countFiles(path: string): Promise<number> {
      let count = 0;
      const entries = await readDir(path);
      
      for (const entry of entries) {
        const fullPath = `${path}/${entry.name}`;
        if (entry.isFile) {
          count++;
        } else if (entry.isDirectory) {
          count += await countFiles(fullPath);
        }
      }
      
      return count;
    }
    
    totalFiles = await countFiles(dirPath);
    
    // 递归函数计算目录大小（分批处理）
    async function calculateSize(path: string): Promise<number> {
      let size = 0;
      const entries = await readDir(path);
      
      // 分批处理文件
      const batchSize = 10;
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        
        for (const entry of batch) {
          const fullPath = `${path}/${entry.name}`;
          if (entry.isFile) {
            try {
              // 对于文件，读取其内容长度
              const content = await readFile(fullPath);
              size += content.byteLength;
              processedFiles++;
              
              // 触发进度回调
              if (onProgress && totalFiles > 0) {
                onProgress(processedFiles, totalFiles);
              }
              
              // 每处理10个文件，短暂休息，避免阻塞
              if (processedFiles % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
              }
            } catch (_error) {
              // 忽略无法读取的文件
            }
          } else if (entry.isDirectory) {
            // 对于目录，递归计算
            size += await calculateSize(fullPath);
          }
        }
      }
      
      return size;
    }
    
    totalSize = await calculateSize(dirPath);
    
    // 更新缓存
    directorySizeCache.set(dirPath, {
      size: totalSize,
      timestamp: now
    });
    
    // 清理过期缓存
    for (const [path, item] of directorySizeCache.entries()) {
      if (now - item.timestamp >= CACHE_DURATION) {
        directorySizeCache.delete(path);
      }
    }
  } catch (error) {
    console.error('计算目录大小失败:', error);
  }
  
  return totalSize;
}

/**
 * 清除目录大小缓存
 * @param dirPath 可选的目录路径，不提供则清除所有缓存
 */
export function clearDirectorySizeCache(dirPath?: string): void {
  if (dirPath) {
    directorySizeCache.delete(dirPath);
  } else {
    directorySizeCache.clear();
  }
}
