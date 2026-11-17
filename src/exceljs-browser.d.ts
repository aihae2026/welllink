// exceljs 기본 진입점은 Node용(archiver 등)이라 서버 번들까지 커진다. 브라우저용 단일 파일을
// 직접 불러오고 타입만 원래 패키지 것을 쓴다.
declare module "exceljs/dist/exceljs.min.js" {
  import ExcelJS from "exceljs";
  export default ExcelJS;
}
