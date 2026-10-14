// vite ?raw 导入的模块声明（主进程打包用：Worker 源码以字符串内嵌，供 CF API 上传）
declare module '*?raw' {
  const content: string
  export default content
}
